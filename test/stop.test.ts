/**
 * Real-process tests for the stop path. No Docker, no Kubernetes: services are
 * plain `node` processes in their own process group, exactly like spawnService
 * creates them.
 *
 * The motivating incident: a pids.json written by an older Portler (no start
 * token) recorded a pid that the OS has since handed to an unrelated process.
 * `portler down` sent SIGTERM/SIGKILL to that pid's process GROUP, killing a
 * stranger's process tree. Everything below exists to keep that impossible.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readProcessStartToken } from '../src/process/identity.ts';
import { isPidAlive, isPidRunning, processGroupAliveAfterKill, readPids, writePids } from '../src/process/pids.ts';
import { signalDecision, stopOrder, stopServices } from '../src/process/stop.ts';
import type { StopHooks } from '../src/process/stop.ts';
import type { PidsFile, PidServiceInfo } from '../src/types/index.ts';
import { startZombieGroup } from './zombie-group.ts';

let projectDir: string;
const spawned: ChildProcess[] = [];

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-stop-'));
});

afterEach(async () => {
  for (const child of spawned) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  spawned.length = 0;
  await fs.rm(projectDir, { recursive: true, force: true });
});

/** A long-lived process in its own group, like the ones Portler supervises. */
async function startSleeper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(child);
  await new Promise((resolve) => child.once('spawn', resolve));
  return child;
}

async function writePidsFile(services: Record<string, PidServiceInfo>): Promise<void> {
  const pids: PidsFile = {
    version: 1,
    project: projectDir,
    startedAt: new Date().toISOString(),
    services,
  };
  await writePids(projectDir, pids);
}

function pidInfo(pid: number, startToken: string | undefined): PidServiceInfo {
  return {
    pid,
    command: 'node -e ...',
    cwd: projectDir,
    startToken,
    startedAt: new Date().toISOString(),
  };
}

/** Poll until the pid is gone, so the assertion does not race the signal. */
/** Waits until `pid` no longer runs: a zombie counts as exited, as under a PID 1 that never reaps it stays one. */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

describe('signalDecision', () => {
  it('signals the group of a pid whose token matches', () => {
    assert.equal(signalDecision('match', 'alive', false), 'group');
  });

  it('never signals a pid the OS handed to someone else', () => {
    assert.equal(signalDecision('reused', 'alive', false), 'none');
    // Not even if we proved ownership earlier in this same stop: the pid was
    // released and recycled inside the grace window, and the group id with it.
    assert.equal(signalDecision('reused', 'alive', true), 'none');
  });

  it('never signals a live pid it cannot identify', () => {
    assert.equal(signalDecision('unverifiable', 'alive', false), 'none');
    assert.equal(signalDecision('unverifiable', 'alive', true), 'none');
  });

  it('keeps signalling our group after the leader exits (kernel pgid reservation)', () => {
    // The `sh -c` wrapper dies but the server it spawned lives on. While the
    // group still has members the kernel cannot recycle the pid — and therefore
    // cannot recycle the pgid — so the group is still provably ours.
    assert.equal(signalDecision('gone', 'alive', true), 'group');
  });

  it('does NOT signal a live group whose leader is gone if ownership was never proven', () => {
    // Without a prior proof, a live group under that pgid could belong to a
    // process that recycled the pid, led a group, and exited. Unprovable, so
    // untouchable.
    assert.equal(signalDecision('gone', 'alive', false), 'none');
  });

  it('does nothing when the pid and its group are both gone', () => {
    assert.equal(signalDecision('gone', 'gone', true), 'none');
    assert.equal(signalDecision('gone', 'gone', false), 'none');
  });
});

describe('stopOrder', () => {
  const entry = (dependsOn?: string[]): PidServiceInfo => ({
    pid: 1,
    command: 'x',
    cwd: '/',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...(dependsOn ? { dependsOn } : {}),
  });

  it('stops dependents first and what they depend on last', () => {
    const services = {
      redis: entry([]),
      api: entry(['redis']),
      worker: entry(['redis']),
      web: entry(['api']),
      proxy: entry([]),
    };
    assert.deepEqual(stopOrder(services, ['redis', 'api', 'worker', 'web', 'proxy']), [
      ['worker', 'web', 'proxy'],
      ['api'],
      ['redis'],
    ]);
  });

  it('only orders the selected services', () => {
    const services = { redis: entry([]), api: entry(['redis']), web: entry(['api']) };
    assert.deepEqual(stopOrder(services, ['api', 'web']), [['web'], ['api']]);
    assert.deepEqual(stopOrder(services, ['redis']), [['redis']]);
  });

  it('keeps entries without a recorded dependsOn in one level', () => {
    const services = { redis: entry(), api: entry() };
    assert.deepEqual(stopOrder(services, ['redis', 'api']), [['redis', 'api']]);
  });

  it('puts names on a cycle into the last level instead of looping', () => {
    const services = { a: entry(['b']), b: entry(['a']), c: entry(['a']) };
    assert.deepEqual(stopOrder(services, ['a', 'b', 'c']), [['c'], ['a', 'b']]);
  });
});

describe('stopServices', () => {
  it('stops a service whose recorded start token still matches', async () => {
    const child = await startSleeper();
    const pid = child.pid!;
    await writePidsFile({ api: pidInfo(pid, (await readProcessStartToken(pid)) ?? undefined) });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.unverified, []);
    assert.deepEqual(result.failures, []);
    assert.ok(await waitForExit(pid), 'the service process should have been killed');
    assert.equal(await readPids(projectDir), null, 'the PID file should be removed once empty');
  });

  it('does NOT signal a pid that was recycled onto another process', async () => {
    // pids.json records pid P, process P exits, and the OS hands P to something
    // unrelated. The recorded start token no longer matches, so the pid must be
    // left strictly alone — signalling its GROUP would kill a stranger's tree.
    const survivor = await startSleeper();
    const pid = survivor.pid!;

    await writePidsFile({ api: pidInfo(pid, 'definitely-not-this-processes-start-time') });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, [], 'a reused pid must not be reported as stopped');
    // Give any (buggy) signal time to land before asserting survival.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(isPidRunning(pid), 'the unrelated process holding the pid must survive');

    // The entry is stale by definition — our service is long gone — so the
    // bookkeeping is cleared. That is the part we own.
    assert.equal(await readPids(projectDir), null);
  });

  it('does NOT signal a legacy entry that has no start token', async () => {
    // THE REGRESSION. A pids.json from Portler < 0.2.0 has a pid and no token.
    // The old code called that "unverifiable" and signalled it best-effort. If
    // the pid has since been reused, that kills an unrelated process group.
    const bystander = await startSleeper();
    const pid = bystander.pid!;
    await writePidsFile({ api: pidInfo(pid, undefined) });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, [], 'a pid with no recorded token must never be signalled');
    assert.deepEqual(result.unverified, ['api'], 'it is reported as not stopped');

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(isPidRunning(pid), 'the process must survive an ordinary down');

    // The entry is KEPT: it may be a real service of ours, and silently
    // forgetting it would orphan it with no record anywhere.
    const remaining = await readPids(projectDir);
    assert.deepEqual(Object.keys(remaining?.services ?? {}), ['api']);
  });

  it('does NOT signal a fresh entry whose token capture failed', async () => {
    // Same shape as a legacy entry: pidInfoFor could not read the token, so
    // startToken is undefined. Fail closed, identically.
    const bystander = await startSleeper();
    await writePidsFile({ api: pidInfo(bystander.pid!, undefined) });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.unverified, ['api']);
    assert.ok(isPidRunning(bystander.pid!));
  });

  it('signals an unverifiable pid only when --force is given', async () => {
    // The escape hatch for the legacy case: an explicit, documented user act.
    const child = await startSleeper();
    const pid = child.pid!;
    await writePidsFile({ api: pidInfo(pid, undefined) });

    const result = await stopServices(projectDir, undefined, { force: true });

    assert.deepEqual(result.stopped, ['api']);
    assert.ok(await waitForExit(pid), '--force should stop a legacy entry');
    assert.equal(await readPids(projectDir), null);
  });

  it('refuses a reused pid EVEN with --force', async () => {
    // --force means "I accept the risk on pids you cannot identify". It does not
    // mean "kill a process you have PROVEN belongs to someone else".
    const survivor = await startSleeper();
    const pid = survivor.pid!;
    await writePidsFile({ api: pidInfo(pid, 'a-token-from-a-long-dead-process') });

    const result = await stopServices(projectDir, undefined, { force: true });

    assert.deepEqual(result.stopped, []);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(isPidRunning(pid), 'a proven-foreign pid survives --force');
  });

  it('re-verifies identity between classification and the signal', async () => {
    // The race: the pid is ours when `down` reads pids.json, exits during the
    // stop, and the number is recycled before we signal. Simulated by recording
    // a live pid with a token, then killing it and letting an unrelated process
    // stand in for the recycled number — the token check must catch it at signal
    // time, not only at classification time.
    const original = await startSleeper();
    const pid = original.pid!;
    const token = (await readProcessStartToken(pid)) ?? undefined;
    assert.ok(token, 'this test needs a real start token');

    await writePidsFile({ api: pidInfo(pid, token) });

    // The process exits; the pid entry now points at nothing. Wait for Node to
    // reap it (its own child), not just for it to stop running: an unreaped
    // zombie would still answer to its pid and start token.
    const reaped = new Promise((resolve) => original.once('exit', resolve));
    process.kill(pid, 'SIGKILL');
    await reaped;

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, [], 'a pid that died before the signal is not "stopped"');
    assert.equal(await readPids(projectDir), null, 'its entry is pruned');
  });

  it('stops a dependency only after the services that depend on it have exited', async () => {
    // The dependent drains for 300 ms on SIGTERM; the dependency notes when its
    // own SIGTERM arrives. pids.json lists the dependency first, as start order does.
    const marks = path.join(projectDir, 'marks');
    await fs.mkdir(marks);
    const script = (name: string, drainMs: number) =>
      `const fs = require('fs'); process.on('SIGTERM', () => {` +
      ` fs.writeFileSync(${JSON.stringify(path.join(marks, `${name}.term`))}, String(Date.now()));` +
      ` setTimeout(() => { fs.writeFileSync(${JSON.stringify(path.join(marks, `${name}.exit`))}, String(Date.now())); process.exit(0); }, ${drainMs}); });` +
      ` fs.writeFileSync(${JSON.stringify(path.join(marks, `${name}.ready`))}, ''); setInterval(() => {}, 1000);`;
    const start = async (name: string, drainMs: number) => {
      const child = spawn(process.execPath, ['-e', script(name, drainMs)], { detached: true, stdio: 'ignore' });
      spawned.push(child);
      // Wait until the SIGTERM handler is installed, or the signal would kill it outright.
      const ready = path.join(marks, `${name}.ready`);
      for (let i = 0; i < 200; i += 1) {
        if (await fs.stat(ready).then(() => true, () => false)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return child;
    };
    const db = await start('db', 0);
    const api = await start('api', 300);
    await writePidsFile({
      db: pidInfo(db.pid!, (await readProcessStartToken(db.pid!)) ?? undefined),
      api: { ...pidInfo(api.pid!, (await readProcessStartToken(api.pid!)) ?? undefined), dependsOn: ['db'] },
    });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, ['api', 'db']);
    assert.deepEqual(result.failures, []);
    const apiExit = Number(await fs.readFile(path.join(marks, 'api.exit'), 'utf8'));
    const dbTerm = Number(await fs.readFile(path.join(marks, 'db.term'), 'utf8'));
    assert.ok(dbTerm >= apiExit, `db got SIGTERM ${apiExit - dbTerm} ms before api finished draining`);
    assert.equal(await readPids(projectDir), null);
  });


  it('leaves what a dependent needs running when that dependent could not be stopped', async () => {
    // cache <- db <- api, and web on its own. api has no start token, so its
    // identity cannot be proven and it is kept; db and cache must then stay up
    // with it instead of being stopped under a still-running api.
    const entry = (pid: number, token: string | undefined, dependsOn: string[]): PidServiceInfo => ({
      ...pidInfo(pid, token),
      dependsOn,
    });
    await writePidsFile({
      cache: entry(9104, 'cache-token', []),
      db: entry(9103, 'db-token', ['cache']),
      api: entry(9101, undefined, ['db']),
      web: entry(9102, 'web-token', []),
    });
    const tokens: Record<number, string> = { 9102: 'web-token', 9103: 'db-token', 9104: 'cache-token' };
    const signalled = new Set<number>();
    const signals: string[] = [];
    const result = await stopServices(projectDir, undefined, {}, {
      graceMs: 20,
      confirmMs: 50,
      pidRunning: (pid) => !signalled.has(pid),
      pidAlive: (pid) => !signalled.has(pid),
      readStartToken: async (pid) => (signalled.has(pid) ? null : tokens[pid] ?? null),
      groupState: (pid) => (signalled.has(pid) ? 'gone' : 'alive'),
      sendSignal: (pid, signal) => {
        signals.push(`${pid}:${signal}`);
        signalled.add(pid);
        return { status: 'sent' };
      },
    });

    assert.deepEqual(signals, ['9102:SIGTERM'], 'only web may be signalled; db and cache stay up under api');
    assert.deepEqual(result.stopped, ['web']);
    assert.deepEqual(result.unverified, ['api']);
    assert.deepEqual([...result.remaining].sort(), ['api', 'cache', 'db']);
    assert.ok(result.failures.some((f) => f.includes('did not stop service "db"') && f.includes('"api" depends on it')));
    assert.ok(result.failures.some((f) => f.includes('did not stop service "cache"') && f.includes('"db" depends on it')));
    const pids = await readPids(projectDir);
    assert.deepEqual(Object.keys(pids?.services ?? {}).sort(), ['api', 'cache', 'db']);
  });
  it('leaves other services running when stopping one by name', async () => {
    const keep = await startSleeper();
    const drop = await startSleeper();
    await writePidsFile({
      keep: pidInfo(keep.pid!, (await readProcessStartToken(keep.pid!)) ?? undefined),
      drop: pidInfo(drop.pid!, (await readProcessStartToken(drop.pid!)) ?? undefined),
    });

    const result = await stopServices(projectDir, ['drop']);

    assert.deepEqual(result.stopped, ['drop']);
    assert.ok(await waitForExit(drop.pid!));
    assert.ok(isPidRunning(keep.pid!), 'unselected services must keep running');

    const remaining = await readPids(projectDir);
    assert.deepEqual(Object.keys(remaining?.services ?? {}), ['keep']);
  });

  it('kills a service whose group leader exits but whose children live on', { timeout: 10_000 }, async (t) => {
    // The leader must stay alive until stopServices reads its real start token.
    // A timed exit races CI scheduling: if it exits before that read, refusing
    // the unproven group is correct. IPC also proves the grandchild is ready,
    // so this cannot pass just by killing the leader before it forks.
    const grandchildScript = `
      process.on('SIGTERM', () => {});
      setTimeout(() => {}, 60_000);
      process.send('ready');
    `;
    const child = spawn(
      process.execPath,
      ['-e', `
        const { spawn } = require('node:child_process');
        const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        grandchild.once('message', () => process.send(grandchild.pid));
        process.once('message', () => process.exit(0));
      `],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    spawned.push(child);
    const [grandchildPid] = await once(child, 'message', { signal: t.signal });
    assert.equal(typeof grandchildPid, 'number');

    const pid = child.pid!;
    const token = await readProcessStartToken(pid);
    assert.ok(token, 'this test needs a real start token');
    await writePidsFile({ api: pidInfo(pid, token) });

    const signals: NodeJS.Signals[] = [];
    const result = await stopServices(projectDir, undefined, {}, {
      // The grandchild ignores SIGTERM, so no long grace period is needed.
      graceMs: 20,
      readStartToken: async (leaderPid) => {
        assert.equal(leaderPid, pid);
        const current = await readProcessStartToken(leaderPid);
        assert.equal(current, token, 'ownership must be verified while the leader is alive');

        // Hold the first verification open until the leader has really exited
        // and been reaped. Return the real token just read, not a mocked one.
        const exited = once(child, 'exit', { signal: t.signal });
        child.send('exit');
        assert.deepEqual(await exited, [0, null]);
        return current;
      },
      sendSignal: (groupPid, signal) => {
        assert.equal(groupPid, pid);
        assert.equal(isPidRunning(pid), false, 'the leader must already be gone');
        assert.ok(isPidRunning(grandchildPid), 'the grandchild must survive until SIGKILL');
        signals.push(signal);
        process.kill(-groupPid, signal);
        return { status: 'sent' };
      },
    });

    // SIGKILL must exercise the gone-leader/proven-group path, not merely
    // signal a still-live leader or succeed before a grandchild ever existed.
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.unverified, []);
    assert.deepEqual(result.failures, []);
    // Under a PID 1 that does not reap, the killed members stay as zombies and
    // kill(-pid, 0) keeps succeeding, so ask whether anything in the group can
    // still run, the same question stop answers.
    assert.equal(processGroupAliveAfterKill(pid), false, 'nothing in the group may still run');
    assert.equal(await readPids(projectDir), null, 'the confirmed teardown must remove the PID file');
  });

  it('returns nothing when there is no PID file', async () => {
    assert.deepEqual(await stopServices(projectDir), {
      stopped: [],
      unverified: [],
      failures: [],
      completed: [],
      remaining: [],
    });
  });

  it('refuses a PID file copied from another project instead of killing the original project process', async () => {
    const original = await startSleeper();
    const pid = original.pid!;
    const token = (await readProcessStartToken(pid)) ?? undefined;

    await writePids(projectDir, {
      version: 1,
      project: '/the/original/checkout',
      startedAt: new Date().toISOString(),
      services: { api: pidInfo(pid, token) },
    });

    await assert.rejects(stopServices(projectDir), /invalid Portler PID file/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isPidRunning(pid), true, 'the original checkout process must not be signalled from a copied PID file');
  });

  it('reports a service as stopped only once its group is actually gone', async () => {
    // A service that ignores SIGTERM. "We sent SIGTERM" is not a teardown; the
    // SIGKILL round has to finish the job before this counts as stopped.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60_000)"], {
      detached: true,
      stdio: 'ignore',
    });
    spawned.push(child);
    await new Promise((resolve) => child.once('spawn', resolve));

    const pid = child.pid!;
    await writePidsFile({ api: pidInfo(pid, (await readProcessStartToken(pid)) ?? undefined) });

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.failures, []);
    assert.ok(await waitForExit(pid), 'SIGKILL must have finished what SIGTERM did not');
  });
});

/**
 * The second signal round is where a stop can go wrong in ways the first cannot:
 * the pid was proven ours at SIGTERM, and then — inside the grace window — it is
 * released and recycled, or its token stops being readable, or the kernel
 * refuses the kill. `stopped` must not survive any of that, because `down`
 * reports it, prunes the PID entry on the strength of it, and exits 0.
 *
 * The OS will not recycle a pid on cue, so the syscalls are injected. Everything
 * below the hooks is the real stopServices control flow.
 */
describe('stopServices: a PID 1 that does not reap', () => {
  it('reports a service as stopped once its group holds only zombies, and drops its entry', { skip: process.platform !== 'linux' }, async () => {
    // In a container whose PID 1 never reaps orphans (tail -f /dev/null, a
    // shell), a detached service that exits on SIGTERM stays a zombie. Its
    // group still answers kill(-pgid, 0), so down used to wait, send SIGKILL,
    // and report a failure every time, keeping the entry and the port.
    const group = await startZombieGroup(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)']);
    try {
      const token = await readProcessStartToken(group.pgid);
      assert.ok(token, 'the leader has a start token');
      await writePidsFile({ api: pidInfo(group.pgid, token) });

      const result = await stopServices(projectDir);

      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.stopped, ['api']);
      assert.deepEqual(result.remaining, []);
      assert.equal(await readPids(projectDir), null, 'the entry is dropped');
      assert.equal(isPidRunning(group.pgid), true, 'the leader is a zombie, so kill(pid, 0) still sees it');
    } finally {
      await group.release();
    }
  });
});

describe('stopServices: the SIGKILL round', () => {
  const PID = 424_242;
  const TOKEN = 'start-token-of-our-service';

  /** Ignores SIGTERM: the group is always still alive when the SIGKILL round runs. */
  function stubbornHooks(overrides: Partial<StopHooks> = {}): StopHooks {
    return {
      graceMs: 20,
      confirmMs: 40,
      pidRunning: () => true,
      groupState: () => 'alive',
      readStartToken: async () => TOKEN,
      sendSignal: () => ({ status: 'sent' }),
      ...overrides,
    };
  }

  beforeEach(async () => {
    await writePidsFile({ api: pidInfo(PID, TOKEN) });
  });

  it('does not report "stopped" when the pid is RECYCLED between SIGTERM and SIGKILL', async () => {
    // Matched at SIGTERM (so it was signalled), then the process exits and the OS
    // hands the number to a stranger. The SIGKILL round re-verifies, sees a
    // different token, and must refuse — and refusing means the service is NOT
    // stopped: something is still running under that pid, and it is not ours.
    const signals: NodeJS.Signals[] = [];
    let round = 0;

    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        readStartToken: async () => {
          round += 1;
          return round === 1 ? TOKEN : 'a-stranger-took-this-pid';
        },
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      }),
    );

    assert.deepEqual(signals, ['SIGTERM'], 'the stranger\'s process group must never be SIGKILLed');
    assert.deepEqual(result.stopped, [], 'a group we could not finish killing is not "stopped"');
    assert.deepEqual(result.unverified, ['api']);

    const remaining = await readPids(projectDir);
    assert.deepEqual(Object.keys(remaining?.services ?? {}), ['api'], 'the PID entry must be kept, not pruned');
  });

  it('does not report "stopped" when the token becomes UNREADABLE before SIGKILL', async () => {
    // Matched at SIGTERM; by the SIGKILL round the token cannot be read (the
    // /proc entry vanished mid-read, ps failed, ...). "We cannot tell" is not
    // permission to kill a process group, and it is not proof of a teardown.
    let round = 0;
    const signals: NodeJS.Signals[] = [];

    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        readStartToken: async () => {
          round += 1;
          return round === 1 ? TOKEN : null;
        },
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      }),
    );

    assert.deepEqual(signals, ['SIGTERM']);
    assert.deepEqual(result.stopped, []);
    assert.deepEqual(result.unverified, ['api']);
    assert.ok((await readPids(projectDir))?.services.api, 'the PID entry must be kept');
  });

  it('does not report "stopped" when the group survives SIGKILL', async () => {
    // Both rounds went out and the group is still there (a process wedged in
    // uninterruptible sleep, an unreaped group). The teardown did not complete.
    const result = await stopServices(projectDir, undefined, {}, stubbornHooks());

    assert.deepEqual(result.stopped, []);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /still alive/);
    assert.ok((await readPids(projectDir))?.services.api, 'the PID entry must be kept');
  });

  it('does not report "stopped" when the kernel REFUSES the signal', async () => {
    // EPERM: the group exists and is not ours to signal. This was swallowed —
    // `sendSignalToProcessGroup` caught everything — so `down` reported the
    // service stopped, pruned its entry, released its port and exited 0 while the
    // process kept running.
    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        sendSignal: () => ({ status: 'error', message: 'could not send SIGTERM to process group 424242: EPERM' }),
      }),
    );

    assert.deepEqual(result.stopped, []);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]!, /EPERM/);
    assert.ok((await readPids(projectDir))?.services.api, 'the PID entry must be kept');
  });

  it('reports "stopped" when the SIGKILL round confirms the group is gone', async () => {
    // The happy path through the same code: SIGTERM does not do it, SIGKILL does,
    // and the group is observed gone. Only THIS prunes the entry.
    let alive = true;

    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        pidRunning: () => alive,
        groupState: () => (alive ? 'alive' : 'gone'),
        sendSignal: (_pid, signal) => {
          if (signal === 'SIGKILL') alive = false;
          return { status: 'sent' };
        },
      }),
    );

    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.unverified, []);
    assert.deepEqual(result.failures, []);
    assert.equal(await readPids(projectDir), null, 'a confirmed teardown prunes the entry');
  });

  it('confirms a zombie-only group after its own SIGKILL even when the check before it never settles', async () => {
    // Under a PID 1 that does not reap, on a busy host, other processes exiting
    // mid-scan can keep the strict check answering "alive" through the grace
    // period. After this stop's SIGKILL no member can start another process, so
    // the after-kill check decides, and the entry is dropped instead of kept.
    const signals: NodeJS.Signals[] = [];
    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        pidRunning: () => true, // a zombie leader still answers kill(pid, 0)
        pidAlive: () => false, // ...but it is a zombie
        groupState: () => 'alive', // the check before SIGKILL never settles
        groupStateAfterKill: () => 'gone',
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      }),
    );

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'the after-kill check is only used once SIGKILL went out');
    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.failures, []);
    assert.equal(await readPids(projectDir), null, 'the entry is dropped');
  });

  it('counts a group that vanished on its own (ESRCH) as stopped', async () => {
    // The service exited between the identity check and the kill. The signal
    // "failed" with ESRCH, but the thing we wanted gone IS gone.
    let alive = true;

    const result = await stopServices(
      projectDir,
      undefined,
      {},
      stubbornHooks({
        pidRunning: () => alive,
        groupState: () => (alive ? 'alive' : 'gone'),
        sendSignal: () => {
          alive = false;
          return { status: 'gone' };
        },
      }),
    );

    assert.deepEqual(result.stopped, ['api']);
    assert.deepEqual(result.failures, []);
  });
});

/**
 * A Docker service whose supervising `docker run` shell was killed while its
 * container ran on: the leader pid is gone, and the `docker run` client is left
 * in the group until the container goes. A `docker` on PATH stands in for the
 * daemon; its `rm -f` drops a marker that makes the left-behind member exit,
 * the way the real client does when its container is removed.
 */
describe('stopServices: a container whose docker run shell is gone', () => {
  /**
   * `rmDelay` keeps `docker rm` from returning for that many seconds after it
   * drops the marker, so the member can exit before Portler looks at its group.
   */
  async function fakeDocker(
    dir: string,
    marker: string,
    { running = true, rmDelay = 0 }: { running?: boolean; rmDelay?: number } = {},
  ): Promise<string> {
    const bin = path.join(dir, 'fake-bin');
    await fs.mkdir(bin, { recursive: true });
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': projectDir }, running });
    await fs.writeFile(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        'case "$1" in',
        `  rm) : > '${marker}'; sleep ${rmDelay}; exit 0 ;;`,
        `  inspect) printf '%s\\n' '${inspected}' ;;`,
        '  *) echo "Error: No such object" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return bin;
  }

  /** A group whose leader has exited, leaving one member that runs until `marker` exists (or forever). */
  async function orphanedGroup(marker: string | null): Promise<{ leader: number; member: number }> {
    const memberFile = path.join(projectDir, `member-${Date.now()}`);
    const body = marker
      ? `const fs=require('fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(marker)}))process.exit(0)},25)`
      : 'setInterval(()=>{},1000)';
    const leaderScript =
      `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(body)}],{stdio:'ignore'});` +
      `c.unref();require('fs').writeFileSync(${JSON.stringify(memberFile)},String(c.pid));process.exit(0)`;
    const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: 'ignore' });
    spawned.push(leader);
    await once(leader, 'exit');
    const member = Number(await fs.readFile(memberFile, 'utf8'));
    return { leader: leader.pid!, member };
  }

  it('reports it stopped and prunes the entry once removing the container ends the group', { timeout: 15_000 }, async () => {
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const { leader, member } = await orphanedGroup(marker);
    assert.ok(isPidRunning(member), 'the left-behind member runs before down');
    await writePidsFile({ db: { ...pidInfo(leader, undefined), dockerContainer: 'c-db' } });

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db']);
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined);
      assert.ok(await waitForExit(member), 'the member exited when its container was removed');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('reports it stopped when the group is already gone by the time docker rm returns', { timeout: 15_000 }, async () => {
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker, { rmDelay: 0.5 });
    const { leader, member } = await orphanedGroup(marker);
    await writePidsFile({ db: { ...pidInfo(leader, undefined), dockerContainer: 'c-db' } });

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db']);
      assert.ok(!isPidAlive(member), 'the member was gone before Portler first looked at its group');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its tokenless leader is left a zombie', { timeout: 15_000 }, async () => {
    // Under a PID 1 that does not reap, the exited shell stays a zombie: kill(pid, 0)
    // still answers, so an entry without a start token (older Portler, or a token
    // that could not be read) verifies as unverifiable. The container was removed
    // and nothing in the group can run, so it is stopped, signalled by nobody and
    // without a warning.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4242, undefined), dockerContainer: 'c-db' } });

    const signals: NodeJS.Signals[] = [];
    const warnings: string[] = [];
    const savedWrite = process.stderr.write.bind(process.stderr);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        pidRunning: () => true, // a zombie leader still answers kill(pid, 0)
        pidAlive: () => false, // ...but it is a zombie
        groupState: () => 'gone', // and nothing runnable is left in its group
        readStartToken: async () => 'Mon Oct 12 20:48:05 2026 4242',
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
      assert.deepEqual(signals, [], 'nothing is signalled');
      assert.deepEqual(warnings.filter((line) => line.includes('warning')), [], 'and nothing is warned about');
    } finally {
      process.stderr.write = savedWrite;
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its leader pid now belongs to a stranger', { timeout: 15_000 }, async () => {
    // The shell exited long ago and the OS gave its pid to an unrelated process,
    // which here even leads a live group under that number. The token proves the
    // pid is not ours, and the reuse proves our old group was empty, so removing
    // the running container is the stop. The stranger is never signalled.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4242, 'Mon Oct 12 20:48:05 2026 4242'), dockerContainer: 'c-db' } });

    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        pidRunning: () => true, // the stranger answers kill(pid, 0)
        pidAlive: () => true, // and is runnable
        groupState: () => 'alive', // and leads its own group under that number
        readStartToken: async () => 'Tue Oct 13 09:00:00 2026 4242',
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
      assert.deepEqual(signals, [], 'the stranger is never signalled');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its leader pid is reused during the wait', { timeout: 15_000 }, async () => {
    // The shell was already gone when the container was removed, so the service
    // waits for its group. During that wait the old group empties and the OS hands
    // the pid to a stranger that leads a live group under the same number. The
    // token still proves the pid is not ours, so this is a stop, not an orphan.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4242, 'Mon Oct 12 20:48:05 2026 4242'), dockerContainer: 'c-db' } });

    let reused = false;
    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        pidRunning: () => reused,
        pidAlive: () => reused,
        groupState: () => {
          // the old group, and from the first look on the stranger's, are alive
          const state = 'alive';
          reused = true;
          return state;
        },
        readStartToken: async () => 'Tue Oct 13 09:00:00 2026 4242',
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
      assert.deepEqual(signals, [], 'the stranger is never signalled');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its group exits right after the settle wait', { timeout: 15_000 }, async () => {
    // The shell was gone when the container was removed, and the client it left
    // stays alive through the whole settle wait, including the last check. It
    // exits before the signal round looks, so that round sees a plain stale
    // entry. The container was still removed by us, so the service was stopped.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4242, 'Mon Oct 12 20:48:05 2026 4242'), dockerContainer: 'c-db' } });

    let roundStarted = false;
    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        // only verifyPid calls this, and a settling target first meets it in the signal round
        pidRunning: () => {
          roundStarted = true;
          return false;
        },
        pidAlive: () => false,
        groupState: () => (roundStarted ? 'gone' : 'alive'),
        readStartToken: async () => null,
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
      assert.deepEqual(signals, [], 'nothing is signalled');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  for (const outlives of [false, true]) {
    const title = outlives
      ? 'keeps the entry when the group of a leader that exited just before the round outlives the wait'
      : 'counts a removed container stopped when its leader exits just before the signal round';
    it(title, { timeout: 15_000 }, async () => {
      // The shell is still alive when the container is removed and when the
      // settle checks look, so the service is not settling. It exits just before
      // the signal round, leaving its `docker run` client in the group for a
      // moment. The round must not judge that group on the spot.
      const marker = path.join(projectDir, 'removed');
      const bin = await fakeDocker(projectDir, marker);
      const token = 'Mon Oct 12 20:48:05 2026 4242';
      await writePidsFile({ db: { ...pidInfo(4242, token), dockerContainer: 'c-db' } });

      let verifies = 0;
      let exited = false;
      let groupChecksAfterExit = 0;
      const signals: NodeJS.Signals[] = [];
      const savedPath = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
      try {
        const result = await stopServices(projectDir, ['db'], {}, {
          graceMs: 20,
          confirmMs: 300,
          // first verify: the reuse check before the round (leader still ours);
          // second: the signal round (the leader has just exited)
          pidRunning: () => {
            verifies += 1;
            if (verifies >= 2) exited = true;
            return !exited;
          },
          pidAlive: () => !exited,
          readStartToken: async () => (exited ? null : token),
          groupState: () => {
            if (!exited) return 'alive';
            groupChecksAfterExit += 1;
            return outlives || groupChecksAfterExit < 3 ? 'alive' : 'gone';
          },
          sendSignal: (_pid, signal) => {
            signals.push(signal);
            return { status: 'sent' };
          },
        });
        assert.deepEqual(signals, [], 'nothing is signalled');
        if (outlives) {
          assert.deepEqual(result.stopped, []);
          assert.deepEqual(result.unverified, ['db']);
          assert.ok((await readPids(projectDir))?.services.db, 'the entry is kept');
        } else {
          assert.deepEqual(result.stopped, ['db']);
          assert.deepEqual(result.unverified, []);
          assert.deepEqual(result.failures, []);
          assert.deepEqual(result.completed, ['db']);
          assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
        }
      } finally {
        process.env.PATH = savedPath;
      }
    });
  }

  it('counts a removed container stopped when its late-exiting leader pid is reused during the late wait', { timeout: 15_000 }, async () => {
    // The shell exits just before the signal round (so its refusal is held back),
    // its group then empties, and its pid goes to a stranger that leads a group
    // under the same number. The group probe reads alive to the end, but the
    // leader's identity says the pid is no longer ours: the service was stopped.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const ours = 'Mon Oct 12 20:48:05 2026 4242';
    const stranger = 'Mon Oct 12 21:30:00 2026 4242';
    await writePidsFile({ db: { ...pidInfo(4242, ours), dockerContainer: 'c-db' } });

    // 'ours' until the signal round, 'gone' at the round, then a stranger's
    let phase: 'ours' | 'gone' | 'stranger' = 'ours';
    let verifies = 0;
    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        // first verify: the reuse check before the round; second: the round;
        // third: the check after the late wait
        pidRunning: () => {
          verifies += 1;
          if (verifies === 2) phase = 'gone';
          if (verifies >= 3) phase = 'stranger';
          return phase !== 'gone';
        },
        pidAlive: () => phase !== 'gone',
        readStartToken: async () => (phase === 'ours' ? ours : phase === 'stranger' ? stranger : null),
        groupState: () => 'alive',
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(signals, [], 'nothing is signalled, least of all the stranger');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its pid is reused between the round and the hold-back', { timeout: 15_000 }, async () => {
    // At the signal round the leader is gone and its group still alive; before
    // Portler decides whether to hold the refusal back, the group empties and the
    // pid goes to a stranger leading a group under the same number. The refusal
    // is held back anyway, and the check after the wait sees the stranger.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const ours = 'Mon Oct 12 20:48:05 2026 4343';
    const stranger = 'Mon Oct 12 21:30:00 2026 4343';
    await writePidsFile({ db: { ...pidInfo(4343, ours), dockerContainer: 'c-db' } });

    let phase: 'ours' | 'gone' | 'stranger' = 'ours';
    let verifies = 0;
    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        // first verify: the reuse check before the round (ours); second: the
        // round (gone); after that the pid is a stranger's
        pidRunning: () => {
          verifies += 1;
          if (verifies === 2) phase = 'gone';
          return phase !== 'gone';
        },
        pidAlive: () => phase !== 'gone',
        readStartToken: async () => (phase === 'ours' ? ours : phase === 'stranger' ? stranger : null),
        // the round reads the old group alive; right after, the stranger takes
        // the pid and leads a group under it
        groupState: () => {
          if (phase === 'gone') phase = 'stranger';
          return 'alive';
        },
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(signals, [], 'nothing is signalled, least of all the stranger');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its pid is reused right after the late check', { timeout: 15_000 }, async () => {
    // The leader exits just before the round, so its refusal waits out the late
    // wait. The check after it sees the leader gone and its group gone; a
    // stranger then takes the pid (without leading a group). That later
    // liveness must not overturn the gone/gone just sampled.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const ours = 'Mon Oct 12 20:48:05 2026 4444';
    await writePidsFile({ db: { ...pidInfo(4444, ours), dockerContainer: 'c-db' } });

    let verifies = 0;
    const signals: NodeJS.Signals[] = [];
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 200,
        // first verify: the reuse check before the round (ours, alive); every
        // later one finds the pid gone
        pidRunning: () => {
          verifies += 1;
          return verifies === 1;
        },
        // the stranger holds the pid by the time anything asks after the check
        pidAlive: () => true,
        readStartToken: async () => ours,
        // the old group lives on until the check after the late wait
        groupState: () => (verifies >= 3 ? 'gone' : 'alive'),
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(signals, [], 'nothing is signalled');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('counts a removed container stopped when its tokenless pid goes to a stranger after the group is seen gone', { timeout: 15_000 }, async () => {
    // An entry without a start token verifies as unverifiable, so its refusal is
    // held back. During the wait its old group is seen gone; a stranger then
    // takes the pid and leads a group under that number. Re-probing would read
    // that stranger's group as alive, so the gone that was seen must stand.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4545, undefined), dockerContainer: 'c-db' } });

    let verifies = 0;
    let probesAfterRound = 0;
    const signals: NodeJS.Signals[] = [];
    const warnings: string[] = [];
    const savedWrite = process.stderr.write.bind(process.stderr);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs: 300,
        // the old leader, then the stranger: something always answers at the pid
        pidRunning: () => {
          verifies += 1;
          return true;
        },
        pidAlive: () => true,
        readStartToken: async () => 'Mon Oct 12 21:00:00 2026 4545',
        // the round's probe reads alive; the first probe of the late wait sees
        // the old group gone; after that the stranger's own group answers
        groupState: () => {
          if (verifies < 2) return 'alive';
          probesAfterRound += 1;
          return probesAfterRound === 2 ? 'gone' : 'alive';
        },
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(signals, [], 'nothing is signalled');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.completed, ['db']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the entry is pruned');
      assert.deepEqual(warnings.filter((line) => line.includes('warning')), [], 'and nothing is warned about');
    } finally {
      process.stderr.write = savedWrite;
      process.env.PATH = savedPath;
    }
  });

  it('keeps a group seen gone during the settle wait counted as gone while another group holds the wait', { timeout: 15_000 }, async () => {
    // db (no start token) and cache both had their shells exit before down
    // started. db's old group is seen gone mid-wait; a stranger then takes its pid
    // and leads a group under that number. cache's group never goes, so the wait
    // runs on. The gone seen for db must stand rather than be re-probed.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({
      db: { ...pidInfo(4646, undefined), dockerContainer: 'c-db' },
      cache: { ...pidInfo(4747, 'Mon Oct 12 20:48:05 2026 4747'), dockerContainer: 'c-cache' },
    });

    let dbProbes = 0;
    let stranger = false;
    const signals: NodeJS.Signals[] = [];
    const savedWrite = process.stderr.write.bind(process.stderr);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const result = await stopServices(projectDir, ['db', 'cache'], {}, {
        graceMs: 20,
        confirmMs: 300,
        // db's pid is free until its group is seen gone, then a stranger holds it
        pidRunning: (pid) => (pid === 4646 ? stranger : false),
        pidAlive: (pid) => (pid === 4646 ? stranger : false),
        readStartToken: async (pid) => (pid === 4646 && stranger ? 'Mon Oct 12 21:00:00 2026 4646' : null),
        groupState: (pid) => {
          if (pid !== 4646) return 'alive'; // cache's group never goes
          dbProbes += 1;
          if (dbProbes === 2) {
            stranger = true;
            return 'gone';
          }
          return 'alive'; // before: the old group; after: the stranger's own
        },
        sendSignal: (_pid, signal) => {
          signals.push(signal);
          return { status: 'sent' };
        },
      });
      assert.deepEqual(signals, [], 'nothing is signalled');
      assert.deepEqual(result.stopped, ['db']);
      assert.deepEqual(result.unverified, ['cache']);
      assert.equal((await readPids(projectDir))?.services.db, undefined, "db's entry is pruned");
      assert.ok((await readPids(projectDir))?.services.cache, "cache's entry is kept");
    } finally {
      process.stderr.write = savedWrite;
      process.env.PATH = savedPath;
    }
  });

  it('does not call an already-exited container stopped, only prunes its entry', { timeout: 15_000 }, async () => {
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker, { running: false });
    const leader = spawn(process.execPath, ['-e', 'process.exit(0)'], { detached: true, stdio: 'ignore' });
    spawned.push(leader);
    await once(leader, 'exit');
    await writePidsFile({ db: { ...pidInfo(leader.pid!, undefined), dockerContainer: 'c-db' } });

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db']);
      assert.deepEqual(result.stopped, []);
      assert.deepEqual(result.unverified, []);
      assert.deepEqual(result.failures, []);
      assert.equal((await readPids(projectDir))?.services.db, undefined, 'the stale entry is pruned');
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('gives a removed container whose leader was already gone one confirm window, not two', { timeout: 15_000 }, async () => {
    // The shell had exited before down started and its group never goes. The
    // settle wait spends the confirm window on it; the later hold-back must not
    // add a second one, so the warning comes after about one window in all.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    await writePidsFile({ db: { ...pidInfo(4242, 'Mon Oct 12 20:48:05 2026 4242'), dockerContainer: 'c-db' } });

    const probeTimes: number[] = [];
    const warnings: string[] = [];
    const savedWrite = process.stderr.write.bind(process.stderr);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const confirmMs = 500;
    try {
      const result = await stopServices(projectDir, ['db'], {}, {
        graceMs: 20,
        confirmMs,
        pidRunning: () => false, // the leader exited before down started
        pidAlive: () => false,
        groupState: () => {
          probeTimes.push(Date.now());
          return 'alive'; // and its group never goes
        },
        sendSignal: () => ({ status: 'sent' }),
      });
      assert.deepEqual(result.stopped, []);
      assert.deepEqual(result.unverified, ['db']);
      assert.ok((await readPids(projectDir))?.services.db, 'the entry is kept');
      assert.equal(warnings.filter((line) => line.includes('warning')).length, 1, 'one warning');
      const span = probeTimes[probeTimes.length - 1]! - probeTimes[0]!;
      assert.ok(span < confirmMs * 1.6, `the group was watched for ${span} ms, about one ${confirmMs} ms window`);
    } finally {
      process.stderr.write = savedWrite;
      process.env.PATH = savedPath;
    }
  });

  it('judges each held-back container at its own deadline, not at the last one', { timeout: 15_000 }, async () => {
    // db's shell had exited before down started, so db spends the settle wait;
    // cache's shell exits just before the signal round and gets its own window
    // after it. Neither group ever goes. db must be judged when its window ends,
    // not held on until cache's later one ends too.
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const token = 'Mon Oct 12 20:48:05 2026 5252';
    await writePidsFile({
      db: { ...pidInfo(4242, 'Mon Oct 12 20:48:05 2026 4242'), dockerContainer: 'c-db' },
      cache: { ...pidInfo(5252, token), dockerContainer: 'c-cache' },
    });

    let cacheVerifies = 0;
    let cacheExited = false;
    const dbProbes: number[] = [];
    const savedWrite = process.stderr.write.bind(process.stderr);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const confirmMs = 500;
    try {
      const result = await stopServices(projectDir, ['db', 'cache'], {}, {
        graceMs: 20,
        confirmMs,
        pidRunning: (pid) => {
          if (pid === 4242) return false; // db's leader exited before down started
          cacheVerifies += 1; // first: the reuse check before the round; second: the round
          if (cacheVerifies >= 2) cacheExited = true;
          return !cacheExited;
        },
        pidAlive: (pid) => (pid === 4242 ? false : !cacheExited),
        readStartToken: async (pid) => (pid === 5252 && !cacheExited ? token : null),
        groupState: (pid) => {
          if (pid === 4242) dbProbes.push(Date.now());
          return 'alive'; // neither group ever goes
        },
        sendSignal: () => ({ status: 'sent' }),
      });
      assert.deepEqual(result.stopped, []);
      assert.deepEqual([...result.unverified].sort(), ['cache', 'db']);
      const span = dbProbes[dbProbes.length - 1]! - dbProbes[0]!;
      assert.ok(span < confirmMs * 1.6, `db's group was watched for ${span} ms, about one ${confirmMs} ms window`);
    } finally {
      process.stderr.write = savedWrite;
      process.env.PATH = savedPath;
    }
  });

  it('still keeps the entry when the group outlives its removed container', { timeout: 15_000 }, async () => {
    const marker = path.join(projectDir, 'removed');
    const bin = await fakeDocker(projectDir, marker);
    const { leader, member } = await orphanedGroup(null);
    await writePidsFile({ db: { ...pidInfo(leader, undefined), dockerContainer: 'c-db' } });

    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir, ['db'], {}, { confirmMs: 300 });
      assert.deepEqual(result.stopped, []);
      assert.deepEqual(result.unverified, ['db']);
      assert.deepEqual(result.completed, []);
      assert.ok((await readPids(projectDir))?.services.db, 'the entry is kept');
      assert.ok(isPidRunning(member), 'nothing was signalled');
    } finally {
      process.env.PATH = savedPath;
      try {
        process.kill(member, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });
});

describe('stopServices in dependency levels with a Docker network', () => {
  /** A fake docker on PATH that logs every call; `network rm` fails when `networkRmFails`. */
  async function networkDocker(networkRmFails: boolean): Promise<{ bin: string; log: string }> {
    const bin = path.join(projectDir, 'fake-bin');
    const log = path.join(projectDir, 'docker.log');
    await fs.mkdir(bin, { recursive: true });
    const container = JSON.stringify({ id: 'sha256:c-api', labels: { 'portler.project': projectDir }, running: false });
    const network = JSON.stringify({ id: 'net-id', labels: { 'portler.project': projectDir } });
    const rm = networkRmFails
      ? `echo "Error response from daemon: error while removing network: network net-x has active endpoints" >&2; exit 1`
      : 'exit 0';
    await fs.writeFile(
      path.join(bin, 'docker'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${log}'`,
        'case "$1 $2" in',
        `  "network inspect") printf '%s\\n' '${network}' ;;`,
        `  "network rm") ${rm} ;;`,
        `  inspect*) printf '%s\\n' '${container}' ;;`,
        '  rm*) exit 0 ;;',
        '  *) echo "Error: No such object" >&2; exit 1 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { bin, log };
  }

  /** api runs in Docker and is the only entry naming the network; it depends on a local db. */
  async function mixedStack(): Promise<Record<string, PidServiceInfo>> {
    const api = await startSleeper();
    const db = await startSleeper();
    const services: Record<string, PidServiceInfo> = {
      api: {
        ...pidInfo(api.pid!, (await readProcessStartToken(api.pid!)) ?? undefined),
        dockerContainer: 'c-api',
        dockerNetwork: 'net-x',
        dependsOn: ['db'],
      },
      db: { ...pidInfo(db.pid!, (await readProcessStartToken(db.pid!)) ?? undefined), dependsOn: [] },
    };
    await writePidsFile(services);
    return services;
  }

  it('removes the network after the last level, though the entry naming it was pruned in the first', { timeout: 15_000 }, async () => {
    await mixedStack();
    const { bin, log } = await networkDocker(false);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir);
      assert.deepEqual(result.failures, []);
      assert.deepEqual([...result.completed].sort(), ['api', 'db']);
      assert.deepEqual(result.remaining, []);
      assert.equal(await readPids(projectDir), null);
      const calls = (await fs.readFile(log, 'utf8')).split('\n');
      assert.ok(calls.includes('network rm net-id'), `the network was removed; docker calls:\n${calls.join('\n')}`);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('keeps the entry that names a network it could not remove', { timeout: 15_000 }, async () => {
    const services = await mixedStack();
    const { bin } = await networkDocker(true);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      const result = await stopServices(projectDir);
      assert.equal(result.failures.length, 1);
      assert.match(result.failures[0]!, /could not remove Docker network "net-x"/);
      assert.deepEqual(result.completed, ['db']);
      assert.deepEqual(result.remaining, ['api']);
      assert.deepEqual((await readPids(projectDir))?.services, { api: services.api });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
