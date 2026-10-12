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
import { readRegistry } from '../src/ports/registry.ts';
import { isPidRunning, readPids, updatePids, writePids } from '../src/process/pids.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../src/state/lock.ts';

let projectDir: string;
let globalDir: string;
let previousCwd: string;
let previousGlobalDir: string | undefined;
const childPids = new Set<number>();

beforeEach(async () => {
  previousCwd = process.cwd();
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
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
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(globalDir, { recursive: true, force: true });
});

async function startForeground() {
  const config = await loadConfig(projectDir);
  const stack = await withLifecycleLock(projectDir, () => startPhase(config, 'local', ['api'], { detach: false }));
  for (const child of stack.children.values()) childPids.add(child.pid!);
  return stack;
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
    await withLifecycleLockForTeardown(projectDir, stack.teardown);
    t.mock.restoreAll();

    assert.deepEqual(signals, [], 'nothing the replacement depends on may be signalled');
    assert.deepEqual(await readPids(projectDir), afterRestart, 'api replacement, db and proxy entries survive');
    assert.deepEqual(await readRegistry(), registry, 'their reservations survive');
    for (const name of ['db', 'api', PROXY_SERVICE_NAME]) {
      assert.ok(isPidRunning(afterRestart.services[name]!.pid), `${name} must still be alive`);
    }
    for (const name of ['db', PROXY_SERVICE_NAME]) {
      assert.ok(notices.some((text) => text.includes(`"${name}"`) && text.includes('depends on it')), `notice for ${name}`);
    }
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

  for (const changed of ['pid', 'startToken'] as const) {
    it(`preserves an entry when only its ${changed} differs`, { timeout: 10_000 }, async () => {
      const stack = await startForeground();
      const original = (await readPids(projectDir))!;
      assert.ok(original.services.api!.startToken);
      // No OS PID recycling or timestamp timing required: change one field in
      // the recorded generation, leaving the other identical to this run.
      let replacementPid = original.services.api!.pid;
      if (changed === 'pid') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true,
          stdio: 'ignore',
        });
        childPids.add(child.pid!);
        await once(child, 'spawn');
        replacementPid = child.pid!;
      }
      await withLifecycleLock(projectDir, () => updatePids(projectDir, (pids) => {
        if (changed === 'pid') pids.services.api!.pid = replacementPid;
        else pids.services.api!.startToken = 'another-run-start-token';
      }));
      const replacement = (await readPids(projectDir))!.services.api!;
      const reservation = (await readRegistry()).ports[String(replacement.port)];

      await withLifecycleLockForTeardown(projectDir, stack.teardown);

      assert.deepEqual((await readPids(projectDir))?.services.api, replacement);
      assert.deepEqual((await readRegistry()).ports[String(replacement.port)], reservation);
      assert.ok(isPidRunning(original.services.api!.pid), 'the changed entry must not authorize signalling');
      assert.ok(isPidRunning(replacementPid), 'the replacement must survive');
      // The proxy is still ours, but the foreign api is served through it: it stays,
      // as something a service another run started depends on, reservation included.
      const after = (await readPids(projectDir))!;
      assert.deepEqual(after.services[PROXY_SERVICE_NAME], original.services[PROXY_SERVICE_NAME], 'the proxy stays for the foreign api');
      assert.ok(isPidRunning(after.services[PROXY_SERVICE_NAME]!.pid));
    });
  }

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
