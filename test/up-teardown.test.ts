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
      // The unchanged proxy is still ours and must be cleaned up normally.
      assert.equal((await readPids(projectDir))?.services[PROXY_SERVICE_NAME], undefined);
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
