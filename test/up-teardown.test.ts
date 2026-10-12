/** Real-process regressions for the foreground up / restart teardown race. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandRestart } from '../src/cli/commands/restart.ts';
import { startPhase } from '../src/cli/commands/up.ts';
import { loadConfig } from '../src/config/index.ts';
import { PROXY_SERVICE_NAME } from '../src/constants.ts';
import { readRegistry, writeRegistry } from '../src/ports/registry.ts';
import { isPidAlive, isPidRunning, readPids, updatePids, writePids } from '../src/process/pids.ts';
import { readProcessStartToken } from '../src/process/identity.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../src/state/lock.ts';

let projectDir: string;
let globalDir: string;
let previousCwd: string;
let previousGlobalDir: string | undefined;
let previousPath: string | undefined;
const childPids = new Set<number>();

beforeEach(async () => {
  previousCwd = process.cwd();
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
  previousPath = process.env.PATH;
  projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-teardown-')));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-global-'));
  process.env.PORTLER_GLOBAL_DIR = globalDir;
  process.chdir(projectDir);
  await fs.writeFile(path.join(projectDir, 'server.cjs'), `
    require('node:net').createServer().listen(Number(process.env.PORT), '127.0.0.1');
  `);
  await fs.writeFile(path.join(projectDir, 'portler.yml'), [
    'services:',
    '  api:',
    `    command: exec "${process.execPath}" server.cjs`,
    '    port: 3000',
    '    port_env: PORT',
    'proxy:',
    '  routes:',
    '    /: api',
    '',
  ].join('\n'));
});

afterEach(async () => {
  // Track both generations, even if an assertion fails or teardown drops an
  // entry. Each service uses exec, so its tracked pid is its group leader.
  const pids = await readPids(projectDir);
  for (const info of Object.values(pids?.services ?? {})) childPids.add(info.pid);
  for (const pid of childPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already stopped.
    }
  }
  childPids.clear();
  process.chdir(previousCwd);
  if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
  else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(globalDir, { recursive: true, force: true });
});

async function startForeground() {
  const config = await loadConfig(projectDir);
  const stack = await withLifecycleLock(projectDir, () => startPhase(config, 'local', ['api'], { detach: false }));
  for (const child of stack.children.values()) childPids.add(child.pid!);
  return stack;
}

/**
 * A fake `docker` on PATH. Both the teardown's container check and
 * stopServices' removal go through it: it answers `inspect` for any container
 * with the scripted state under this project's label, succeeds at `rm`, and
 * logs every argv so the test can see what was asked.
 */
async function installFakeDocker(state: 'running' | 'exited' | 'unreachable'): Promise<{ calls: () => Promise<string[]> }> {
  const bin = path.join(projectDir, 'fake-bin');
  const log = path.join(projectDir, 'docker-calls.log');
  await fs.mkdir(bin, { recursive: true });
  const inspected = JSON.stringify({ id: 'sha256:replacement', labels: { 'portler.project': projectDir }, running: state === 'running' });
  const inspect =
    state === 'unreachable'
      ? 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1'
      : `printf '%s\\n' '${inspected}'`;
  await fs.writeFile(
    path.join(bin, 'docker'),
    ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, 'case "$1" in', `  inspect) ${inspect} ;;`, '  rm) ;;', '  *) echo "unexpected docker $*" >&2; exit 1 ;;', 'esac', ''].join('\n'),
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  return { calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

/**
 * A zombie: the child of a stopped parent exits and cannot be reaped until the
 * parent runs again. A detached replacement that exited under a PID 1 that does
 * not reap orphans looks exactly like this. `release` resumes the parent, which
 * reaps it and exits.
 */
async function makeZombie(): Promise<{ pid: number; release: () => Promise<void> }> {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });",
    "process.stdout.write(child.pid + '\\n', () => process.kill(process.pid, 'SIGSTOP'));",
  ].join('\n');
  const helper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(helper.stdout!, 'data');
  const pid = Number(String(chunk).trim());
  for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isPidRunning(pid) && !isPidAlive(pid), true, 'the helper child is a zombie');
  return {
    pid,
    release: async () => {
      if (helper.exitCode !== null || helper.signalCode !== null) return;
      helper.kill('SIGCONT');
      const fallback = setTimeout(() => helper.kill('SIGKILL'), 2000);
      await once(helper, 'exit');
      clearTimeout(fallback);
    },
  };
}

/** What a restart leaves for api: another identity, a Docker service, its supervising shell pid gone. */
async function replaceApiWithDockerService(): Promise<void> {
  await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
    pids.services.api!.pid = 4_194_303;
    pids.services.api!.startToken = 'another-run-start-token';
    pids.services.api!.dockerContainer = 'portler-api-replacement';
  }));
}

describe('foreground teardown ownership', () => {
  it('leaves restarted services and proxy alive, recorded, and reserved', { timeout: 15_000 }, async (t) => {
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;

    // Drive the exact ordering deterministically through the API: the old
    // foreground run waits, restart stops it and records replacements under
    // the lifecycle lock, then the old run reacquires that lock to tear down.
    assert.equal(await commandRestart(parseArgs([], 'restart')), 0);
    const replacement = (await readPids(projectDir))!;
    const registry = await readRegistry();
    for (const name of ['api', PROXY_SERVICE_NAME]) {
      const info = replacement.services[name]!;
      childPids.add(info.pid);
      assert.notEqual(info.pid, original.services[name]!.pid);
      assert.ok(info.startToken, 'replacement must have a verifiable real identity');
    }

    const signals: number[] = [];
    const kill = process.kill;
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) signals.push(pid);
      return kill(pid, signal);
    });
    const notices: string[] = [];
    t.mock.method(process.stderr, 'write', (text: string) => { notices.push(text); return true; });

    await withLifecycleLockForTeardown(projectDir, stack.teardown);
    t.mock.restoreAll();

    assert.deepEqual(signals, [], 'old foreground teardown must not signal either replacement');
    assert.deepEqual(await readPids(projectDir), replacement, 'replacement entries must survive unchanged');
    assert.deepEqual(await readRegistry(), registry, 'replacement port reservations must survive unchanged');
    for (const name of ['api', PROXY_SERVICE_NAME]) {
      assert.ok(isPidRunning(replacement.services[name]!.pid), `${name} replacement must still be alive`);
      assert.ok(notices.some((text) => text.includes(`"${name}"`) && text.includes('another run')));
    }
  });

  it('keeps a dependency and the proxy that a named restart adopted', { timeout: 15_000 }, async (t) => {
    // `restart api` replaces api and leaves db and the proxy as they are: their
    // entries still match this run, but the replacement depends on them.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), [
      'services:',
      '  db:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3001',
      '    port_env: PORT',
      '  api:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3000',
      '    port_env: PORT',
      '    depends_on: [db]',
      'proxy:',
      '  routes:',
      '    /: api',
      '',
    ].join('\n'));
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    assert.ok(original.services.db && original.services.api && original.services[PROXY_SERVICE_NAME]);

    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    assert.notEqual(afterRestart.services.api!.pid, original.services.api!.pid, 'api was replaced');
    assert.deepEqual(afterRestart.services.db, original.services.db, 'db was kept by the restart');
    assert.deepEqual(afterRestart.services[PROXY_SERVICE_NAME], original.services[PROXY_SERVICE_NAME], 'the proxy was kept by the restart');
    const registry = await readRegistry();

    const signals: number[] = [];
    const kill = process.kill;
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) signals.push(pid);
      return kill(pid, signal);
    });
    const notices: string[] = [];
    t.mock.method(process.stderr, 'write', (text: string) => { notices.push(text); return true; });
    const kept = await withLifecycleLockForTeardown(projectDir, stack.teardown);
    t.mock.restoreAll();

    assert.deepEqual([...kept].sort(), ['db', PROXY_SERVICE_NAME].sort(), 'the teardown names what it kept, so the supervisor can stay attached');
    assert.deepEqual(signals, [], 'nothing the replacement depends on may be signalled');
    assert.deepEqual(await readPids(projectDir), afterRestart, 'api replacement, db and proxy entries survive');
    assert.deepEqual(await readRegistry(), registry, 'their reservations survive');
    for (const name of ['db', 'api', PROXY_SERVICE_NAME]) {
      assert.ok(isPidRunning(afterRestart.services[name]!.pid), `${name} must still be alive`);
    }
    for (const name of ['db', PROXY_SERVICE_NAME]) {
      assert.ok(notices.some((text) => text.includes(`"${name}"`) && text.includes('depends on it')), `notice for ${name}`);
    }

    // The Ctrl-C that follows the supervisor's notice stops them anyway, and
    // still leaves the replacement alone: it is not this run's.
    const stillKept = await withLifecycleLockForTeardown(projectDir, () => stack.teardown({ keepAdopted: false }));
    assert.deepEqual(stillKept, []);
    const afterStop = (await readPids(projectDir))!;
    assert.deepEqual(Object.keys(afterStop.services), ['api'], 'only the replacement is left on record');
    assert.deepEqual(afterStop.services.api, afterRestart.services.api);
    assert.ok(isPidRunning(afterRestart.services.api!.pid), 'the replacement keeps running');
    for (const name of ['db', PROXY_SERVICE_NAME]) {
      assert.equal(isPidRunning(afterRestart.services[name]!.pid), false, `${name} was stopped`);
    }
  });

  it('prunes an adopted dependency that died before the teardown ran', { timeout: 15_000 }, async () => {
    // `restart api` keeps db for the replacement, and db then crashes before
    // the foreground teardown takes the lifecycle lock. Its entry still matches
    // this run, and the replacement still depends on it, but a dead db is
    // nothing to keep: it is pruned and its port released, not reported as kept.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), [
      'services:',
      '  db:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3001',
      '    port_env: PORT',
      '  api:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3000',
      '    port_env: PORT',
      '    depends_on: [db]',
      'proxy:',
      '  routes:',
      '    /: api',
      '',
    ].join('\n'));
    const stack = await startForeground();
    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    const db = afterRestart.services.db!;
    const dbPort = String(db.port);
    assert.ok((await readRegistry()).ports[dbPort], 'db holds a reservation before the teardown');
    process.kill(-db.pid, 'SIGKILL');
    for (let i = 0; i < 100 && isPidRunning(db.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(isPidRunning(db.pid), false, 'db is gone before the teardown runs');

    const kept = await withLifecycleLockForTeardown(projectDir, stack.teardown);

    assert.deepEqual(kept, [PROXY_SERVICE_NAME], 'only the live proxy is kept; the dead db is not');
    const after = (await readPids(projectDir))!;
    assert.ok(!after.services.db, "db's dead entry is pruned");
    assert.equal((await readRegistry()).ports[dbPort], undefined, 'and its reservation is released');
    assert.deepEqual(after.services.api, afterRestart.services.api, 'the replacement is left alone');
    assert.ok(isPidRunning(afterRestart.services.api!.pid), 'the replacement keeps running');
    assert.ok(isPidRunning(afterRestart.services[PROXY_SERVICE_NAME]!.pid), 'the proxy the replacement is served through stays');
  });

  it('still stops what no other run depends on after a named restart', { timeout: 15_000 }, async () => {
    // db is this run's and nothing the replacement api needs: it is stopped and
    // released as before. The proxy serves the replacement and stays.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), [
      'services:',
      '  db:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3001',
      '    port_env: PORT',
      '  api:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3000',
      '    port_env: PORT',
      'proxy:',
      '  routes:',
      '    /: api',
      '',
    ].join('\n'));
    const config = await loadConfig(projectDir);
    const stack = await withLifecycleLock(projectDir, () => startPhase(config, 'local', ['db', 'api'], { detach: false }));
    for (const child of stack.children.values()) childPids.add(child.pid!);
    const original = (await readPids(projectDir))!;

    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    const dbPort = String(original.services.db!.port);
    assert.ok((await readRegistry()).ports[dbPort], 'db holds a reservation before the teardown');

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = (await readPids(projectDir))!;
    assert.equal(after.services.db, undefined, 'db, which nothing else needs, is stopped');
    assert.ok(!isPidRunning(original.services.db!.pid), 'db is gone');
    assert.equal((await readRegistry()).ports[dbPort], undefined, 'and its reservation is released');
    assert.deepEqual(after.services.api, afterRestart.services.api, 'the api replacement is untouched');
    assert.deepEqual(after.services[PROXY_SERVICE_NAME], afterRestart.services[PROXY_SERVICE_NAME], 'the proxy stays for the replacement');
    assert.ok(isPidRunning(afterRestart.services.api!.pid) && isPidRunning(afterRestart.services[PROXY_SERVICE_NAME]!.pid));
  });

  const independentConfig = [
    'services:',
    '  db:',
    `    command: exec "${process.execPath}" server.cjs`,
    '    port: 3001',
    '    port_env: PORT',
    '  api:',
    `    command: exec "${process.execPath}" server.cjs`,
    '    port: 3000',
    '    port_env: PORT',
    'proxy:',
    '  routes:',
    '    /: api',
    '',
  ].join('\n');
  const dependentConfig = independentConfig.replace('    port_env: PORT\nproxy:', '    port_env: PORT\n    depends_on: [db]\nproxy:');
  assert.notEqual(dependentConfig, independentConfig);

  async function startForegroundWith(configText: string) {
    await fs.writeFile(path.join(projectDir, 'portler.yml'), configText);
    const config = await loadConfig(projectDir);
    const stack = await withLifecycleLock(projectDir, () => startPhase(config, 'local', ['db', 'api'], { detach: false }));
    for (const child of stack.children.values()) childPids.add(child.pid!);
    return stack;
  }

  it('keeps a dependency the restart gained from an edited portler.yml', { timeout: 15_000 }, async (t) => {
    // This run started db and api independent. portler.yml then changed, and
    // `restart api` started a replacement that depends on db. What the
    // replacement recorded decides, not this run's captured config.
    const stack = await startForegroundWith(independentConfig);
    const original = (await readPids(projectDir))!;
    assert.deepEqual(original.services.api!.dependsOn, [], 'this run recorded api without dependencies');

    await fs.writeFile(path.join(projectDir, 'portler.yml'), dependentConfig);
    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    assert.deepEqual(afterRestart.services.api!.dependsOn, ['db'], 'the replacement recorded what it started with');
    assert.deepEqual(afterRestart.services.db, original.services.db, 'db was kept by the restart');
    const registry = await readRegistry();

    const signals: number[] = [];
    const kill = process.kill;
    t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0) signals.push(pid);
      return kill(pid, signal);
    });
    const notices: string[] = [];
    t.mock.method(process.stderr, 'write', (text: string) => { notices.push(text); return true; });
    await withLifecycleLockForTeardown(projectDir, stack.teardown);
    t.mock.restoreAll();

    assert.deepEqual(signals, [], 'db, which the replacement depends on, must not be signalled');
    assert.deepEqual(await readPids(projectDir), afterRestart, 'api replacement, db and proxy entries survive');
    assert.deepEqual(await readRegistry(), registry, 'their reservations survive');
    for (const name of ['db', 'api', PROXY_SERVICE_NAME]) {
      assert.ok(isPidRunning(afterRestart.services[name]!.pid), `${name} must still be alive`);
    }
    assert.ok(notices.some((text) => text.includes('"db"') && text.includes('depends on it')));
  });

  it('stops a dependency the restart dropped through an edited portler.yml', { timeout: 15_000 }, async () => {
    // The mirror image: this run's config made api depend on db, the edited
    // one does not, and the replacement api recorded no dependencies. Nothing
    // live needs db any more, so this run stops and releases it.
    const stack = await startForegroundWith(dependentConfig);
    const original = (await readPids(projectDir))!;
    assert.deepEqual(original.services.api!.dependsOn, ['db']);

    await fs.writeFile(path.join(projectDir, 'portler.yml'), independentConfig);
    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    assert.deepEqual(afterRestart.services.api!.dependsOn, []);
    const dbPort = String(original.services.db!.port);

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = (await readPids(projectDir))!;
    assert.equal(after.services.db, undefined, 'db, which the replacement no longer needs, is stopped');
    assert.ok(!isPidRunning(original.services.db!.pid), 'db is gone');
    assert.equal((await readRegistry()).ports[dbPort], undefined, 'and its reservation is released');
    assert.deepEqual(after.services.api, afterRestart.services.api, 'the api replacement is untouched');
    assert.deepEqual(after.services[PROXY_SERVICE_NAME], afterRestart.services[PROXY_SERVICE_NAME], 'the proxy stays for the replacement');
  });

  it('falls back to the config on disk for an entry that recorded no dependencies', { timeout: 15_000 }, async () => {
    // A PID entry written by an older Portler has no dependsOn. Its
    // dependencies are then read from portler.yml as it is now, which is what
    // such a run most plausibly started from, rather than from this run's copy.
    const stack = await startForegroundWith(independentConfig);
    const original = (await readPids(projectDir))!;

    await fs.writeFile(path.join(projectDir, 'portler.yml'), dependentConfig);
    assert.equal(await commandRestart(parseArgs(['api'], 'restart')), 0);
    await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
      delete pids.services.api!.dependsOn;
    }));
    const afterRestart = (await readPids(projectDir))!;
    childPids.add(afterRestart.services.api!.pid);
    assert.equal(afterRestart.services.api!.dependsOn, undefined);

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = (await readPids(projectDir))!;
    assert.deepEqual(after.services.db, original.services.db, 'db stays: the file on disk says the replacement depends on it');
    assert.ok(isPidRunning(original.services.db!.pid));
    assert.deepEqual(after.services.api, afterRestart.services.api);
    assert.deepEqual(after.services[PROXY_SERVICE_NAME], afterRestart.services[PROXY_SERVICE_NAME]);
  });

  it('preserves a replacement entry whose pid and start token name a live process', { timeout: 10_000 }, async () => {
    // A restart replaced api while the teardown waited: the entry names another
    // live process, recorded with that process's own start token.
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    childPids.add(child.pid!);
    await once(child, 'spawn');
    const token = await readProcessStartToken(child.pid!);
    assert.ok(token, 'the platform reports a start token');
    await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
      pids.services.api!.pid = child.pid!;
      pids.services.api!.startToken = token;
    }));
    const replacement = (await readPids(projectDir))!.services.api!;
    const reservation = (await readRegistry()).ports[String(replacement.port)];

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    assert.deepEqual((await readPids(projectDir))?.services.api, replacement);
    assert.deepEqual((await readRegistry()).ports[String(replacement.port)], reservation);
    assert.ok(isPidRunning(original.services.api!.pid), 'the changed entry must not authorize signalling');
    assert.ok(isPidRunning(child.pid!), 'the replacement must survive');
    // The proxy is still ours, but the foreign api is served through it: it stays,
    // as something a service another run started depends on, reservation included.
    const after = (await readPids(projectDir))!;
    assert.deepEqual(after.services[PROXY_SERVICE_NAME], original.services[PROXY_SERVICE_NAME], 'the proxy stays for the foreign api');
    assert.ok(isPidRunning(after.services[PROXY_SERVICE_NAME]!.pid));
  });

  for (const holder of ['an unrelated process', "this run's own process"] as const) {
    it(`prunes, without signalling, an entry whose pid now holds ${holder}`, { timeout: 10_000 }, async () => {
      // The replacement exited and the OS recycled its pid before the teardown
      // ran: the pid is live, but its start token is not the recorded one. The
      // entry names nothing alive, so it is pruned and its port released, and
      // the process that holds the number now is never signalled.
      const stack = await startForeground();
      const original = (await readPids(projectDir))!;
      let holderPid = original.services.api!.pid;
      if (holder === 'an unrelated process') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        childPids.add(child.pid!);
        await once(child, 'spawn');
        holderPid = child.pid!;
      }
      await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
        pids.services.api!.pid = holderPid;
        pids.services.api!.startToken = 'another-run-start-token';
      }));

      await withLifecycleLockForTeardown(projectDir, stack.teardown);

      const after = await readPids(projectDir);
      assert.ok(!after?.services.api, 'the entry with a recycled pid is pruned');
      assert.ok(!after?.services[PROXY_SERVICE_NAME], 'nothing foreign is live, so the proxy is stopped as usual');
      assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'every reservation is released');
      assert.ok(isPidRunning(holderPid), 'the process holding the pid now is not signalled');
      assert.ok(isPidRunning(original.services.api!.pid), 'nor is this run\'s original api');
    });
  }

  it('prunes a replacement entry whose process already exited and releases its reservation', { timeout: 10_000 }, async () => {
    // This run spawned api, then a restart replaced it while the teardown waited
    // for the lifecycle lock, and the replacement exited before the teardown ran
    // (a service with no readiness check that crashes at once). The entry has a
    // different identity, so it is not this run's to signal, but nothing owns a
    // dead entry: it is pruned, and its port goes back instead of lingering.
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    assert.ok(original.services.api!.startToken);
    await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
      pids.services.api!.pid = 4_194_303;
      pids.services.api!.startToken = 'another-run-start-token';
    }));
    const apiPort = String(original.services.api!.port);
    assert.ok((await readRegistry()).ports[apiPort], 'api holds a reservation before the teardown');

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = await readPids(projectDir);
    assert.ok(!after?.services.api, 'the dead replacement entry is pruned');
    assert.ok(!after?.services[PROXY_SERVICE_NAME], 'nothing foreign is live, so the proxy is stopped as usual');
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'every reservation, the dead replacement\'s included, is released');
    assert.ok(isPidRunning(original.services.api!.pid), 'the entry no longer names this run\'s process, so it is not signalled');
  });

  it('releases the reservation of a dead replacement that gained a port this run never reserved', { timeout: 10_000 }, async () => {
    // worker starts portless, so this run reserves nothing for it. portler.yml
    // is then edited to give worker a port, a restart reserves one for its
    // replacement, and the replacement exits before the teardown. The entry is
    // pruned like any dead one, and the reservation the restart made goes too.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), [
      'services:',
      '  api:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3000',
      '    port_env: PORT',
      '  worker:',
      `    command: exec "${process.execPath}" -e "setInterval(() => {}, 1000)"`,
      '',
    ].join('\n'));
    const config = await loadConfig(projectDir);
    const stack = await withLifecycleLock(projectDir, () => startPhase(config, 'local', ['api', 'worker'], { detach: false }));
    for (const child of stack.children.values()) childPids.add(child.pid!);
    const original = (await readPids(projectDir))!;
    assert.equal(original.services.worker!.port, undefined, 'worker started portless');
    const workerPort = 4_399;
    await withLifecycleLock(projectDir, async () => {
      await updatePids(projectDir, (pids) => {
        pids.services.worker!.pid = 4_194_303;
        pids.services.worker!.startToken = 'another-run-start-token';
        pids.services.worker!.port = workerPort;
      });
      const registry = await readRegistry();
      registry.ports[String(workerPort)] = {
        project: projectDir,
        service: 'worker',
        port: workerPort,
        desiredPort: 4_300,
        host: '127.0.0.1',
        assignedAt: new Date().toISOString(),
      };
      await writeRegistry(registry);
    });

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    assert.ok(!(await readPids(projectDir))?.services.worker, 'the dead replacement entry is pruned');
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'the reservation the restart made for worker is released with the rest');
    assert.ok(isPidRunning(original.services.worker!.pid), 'the entry no longer names this run\'s worker, so it is not signalled');
  });

  it('leaves a Docker replacement alone while its container outlives its supervising pid',{ timeout: 10_000 }, async () => {
    // A restart replaced this run's api with a Docker service. `docker run` is
    // supervised by a shell: its pid can be gone while the container runs on,
    // and stopServices removes a selected service's container by label whatever
    // the pid is doing. A gone pid alone must not hand a Docker entry over.
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    const docker = await installFakeDocker('running');
    await replaceApiWithDockerService();
    const apiPort = String(original.services.api!.port);

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = (await readPids(projectDir))!;
    assert.equal(after.services.api?.dockerContainer, 'portler-api-replacement', 'the entry is left alone');
    assert.ok((await readRegistry()).ports[apiPort], 'and so is its reservation');
    assert.ok(after.services[PROXY_SERVICE_NAME], 'the proxy stays up for the live replacement');
    assert.ok(isPidRunning(after.services[PROXY_SERVICE_NAME]!.pid));
    const calls = await docker.calls();
    assert.ok(calls.some((call) => call.startsWith('inspect --type container ')), 'the container was inspected');
    assert.ok(!calls.some((call) => call.startsWith('rm ')), 'and never removed');
    assert.ok(isPidRunning(original.services.api!.pid), 'this run\'s original process is not signalled either');
  });

  it('prunes a Docker replacement whose container has exited with its pid, removing the container', { timeout: 10_000 }, async () => {
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    const docker = await installFakeDocker('exited');
    await replaceApiWithDockerService();

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = await readPids(projectDir);
    assert.ok(!after?.services.api, 'the dead replacement entry is pruned');
    assert.ok(!after?.services[PROXY_SERVICE_NAME], 'nothing foreign is live, so the proxy is stopped as usual');
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'every reservation is released');
    assert.ok((await docker.calls()).includes('rm -f sha256:replacement'), 'stopServices removes the exited container by id');
    assert.ok(isPidRunning(original.services.api!.pid), 'this run\'s original process is not signalled');
  });

  it('leaves a Docker replacement alone when the daemon cannot be asked', { timeout: 10_000 }, async () => {
    // Unknown is not dead: guessing would remove a container another run may be
    // serving through. The entry, its reservation and the proxy stay, with a notice.
    const stack = await startForeground();
    const original = (await readPids(projectDir))!;
    const docker = await installFakeDocker('unreachable');
    await replaceApiWithDockerService();
    const apiPort = String(original.services.api!.port);

    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    const after = (await readPids(projectDir))!;
    assert.equal(after.services.api?.dockerContainer, 'portler-api-replacement', 'the entry is left alone');
    assert.ok((await readRegistry()).ports[apiPort], 'and so is its reservation');
    assert.ok(after.services[PROXY_SERVICE_NAME], 'the proxy stays up for what may be live');
    assert.ok(!(await docker.calls()).some((call) => call.startsWith('rm ')), 'nothing is removed on a guess');
  });

  it('does not keep the proxy for a replacement that is a zombie', { timeout: 15_000, skip: process.platform === 'win32' }, async () => {
    // A restart replaced api, and the replacement exited under a PID 1 that does
    // not reap orphans: kill(pid, 0) still finds it and its start token is
    // unchanged. That is no service, and no reason to keep the proxy.
    const stack = await startForeground();
    const proxyPid = (await readPids(projectDir))!.services[PROXY_SERVICE_NAME]!.pid;
    const zombie = await makeZombie();
    try {
      const token = await readProcessStartToken(zombie.pid);
      await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
        pids.services.api!.pid = zombie.pid;
        pids.services.api!.startToken = token ?? 'unreadable-start-token';
      }));

      // The zombie's own entry goes to stopServices with the rest, and it, like
      // `portler down`, cannot see the zombie gone: that is reported, not hidden.
      await assert.rejects(
        withLifecycleLockForTeardown(projectDir, () => stack.teardown()),
        (error: Error) => error.name === 'IncompleteTeardownError',
      );
      assert.equal((await readPids(projectDir))!.services[PROXY_SERVICE_NAME], undefined, 'the proxy is not kept');
      assert.equal(isPidRunning(proxyPid), false, 'the proxy was stopped');
      assert.ok(
        !Object.values((await readRegistry()).ports).some((entry) => entry.service === PROXY_SERVICE_NAME),
        "the proxy's reservation is released",
      );
    } finally {
      await zombie.release();
    }
  });

  it('stops what a failed startup started, even when a live service depends on it', { timeout: 15_000 }, async () => {
    // api runs from an earlier run and depends on db, which is not running. This
    // up starts db for web, and web fails. The rollback restores what was there
    // before: db stopped, api untouched. Keeping db for api would leave this
    // failed run attached to a child nobody supervises.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), [
      'services:',
      '  db:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3001',
      '    port_env: PORT',
      '  api:',
      `    command: exec "${process.execPath}" server.cjs`,
      '    port: 3000',
      '    port_env: PORT',
      '    depends_on: [db]',
      '  web:',
      `    command: exec "${process.execPath}" -e "process.exit(3)"`,
      '    port: 3002',
      '    port_env: PORT',
      '    depends_on: [db]',
      '',
    ].join('\n'));
    const api = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    childPids.add(api.pid!);
    const token = await readProcessStartToken(api.pid!);
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: {
        api: { pid: api.pid!, command: 'earlier api', cwd: projectDir, startedAt, ...(token ? { startToken: token } : {}), dependsOn: ['db'] },
      },
    });

    const config = await loadConfig(projectDir);
    await assert.rejects(withLifecycleLock(projectDir, () => startPhase(config, 'local', ['web'], { detach: false })), /web/);
    const after = (await readPids(projectDir))!;
    assert.equal(after.services.db, undefined, 'db, which this failed run started, is stopped and pruned');
    assert.equal(after.services.api?.pid, api.pid, 'the earlier run\'s api is left alone');
    assert.equal(isPidRunning(api.pid!), true);
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'the reservations this run made are released');
  });

  it('prunes a stale entry for a service that never started and releases its reservation', { timeout: 10_000 }, async () => {
    // Startup fails before api is spawned (its env has a dangling reference).
    // A dead entry for api left by an earlier run is not another run's: nothing
    // owns it, so the teardown prunes it and gives back the port this run reserved.
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  api:', '    command: node -e ""', '    port: 3000', '    env:', '      URL: missing.url', ''].join('\n'),
    );
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: { api: { pid: 4_194_303, command: 'old api', cwd: projectDir, port: 3000, startedAt } },
    });
    const config = await loadConfig(projectDir);
    await assert.rejects(withLifecycleLock(projectDir, () => startPhase(config, 'local', ['api'], { detach: false })), /cannot resolve/);
    assert.ok(!(await readPids(projectDir))?.services.api, 'the stale entry is pruned');
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'the reservation made for this run is released');
  });

  it('prunes a stale entry for a portless service that never started', { timeout: 10_000 }, async () => {
    // worker has no port, so it is in neither reserveNames nor startedEntries
    // when startup fails before it is spawned. Its dead leftover entry is still
    // this run's to prune; nothing is released because nothing was reserved.
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  worker:', '    command: node -e ""', '    env:', '      URL: missing.url', ''].join('\n'),
    );
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: { worker: { pid: 4_194_303, command: 'old worker', cwd: projectDir, startedAt } },
    });
    const config = await loadConfig(projectDir);
    await assert.rejects(withLifecycleLock(projectDir, () => startPhase(config, 'local', ['worker'], { detach: false })), /cannot resolve/);
    assert.ok(!(await readPids(projectDir))?.services.worker, 'the stale entry is pruned');
    assert.deepEqual(Object.keys((await readRegistry()).ports), [], 'nothing was reserved, nothing is left');
  });

  it('still stops matching services and proxy and releases their reservations', { timeout: 10_000 }, async () => {
    const stack = await startForeground();
    await withLifecycleLockForTeardown(projectDir, stack.teardown);

    for (const pid of childPids) assert.equal(isPidRunning(pid), false);
    assert.equal(await readPids(projectDir), null);
    assert.deepEqual((await readRegistry()).ports, {});
  });
});
