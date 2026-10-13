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
import { signalDecision, stopServices } from '../src/process/stop.ts';
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

    // The process exits; the pid entry now points at nothing.
    process.kill(pid, 'SIGKILL');
    await waitForExit(pid);

    const result = await stopServices(projectDir);

    assert.deepEqual(result.stopped, [], 'a pid that died before the signal is not "stopped"');
    assert.equal(await readPids(projectDir), null, 'its entry is pruned');
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
