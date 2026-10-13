import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { groupHoldsOnlyZombies, isPidAlive, isPidRunning, processGroupAlive, procHidesProcesses, type GroupScan } from '../src/process/pids.ts';
import { startZombieGroup, waitFor } from './zombie-group.ts';

describe('isPidAlive', () => {
  it('agrees with the existence check for a live process and for a pid nobody holds', () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(0), false);
    assert.equal(isPidAlive(4_194_303), isPidRunning(4_194_303));
  });

  it('counts a zombie as dead where kill(pid, 0) still says alive', { skip: process.platform === 'win32' }, async () => {
    // A child whose parent is stopped cannot be reaped: it exits and stays a
    // zombie until the parent runs again. That is what a dependency's leader
    // looks like under a PID 1 that does not reap orphans.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });",
      "process.stdout.write(child.pid + '\\n', () => process.kill(process.pid, 'SIGSTOP'));",
    ].join('\n');
    const helper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    let zombie = 0;
    try {
      const [chunk] = await once(helper.stdout!, 'data');
      zombie = Number(String(chunk).trim());
      assert.ok(zombie > 0, `helper reported pid ${String(chunk)}`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(isPidRunning(zombie), true, 'kill(pid, 0) still sees the zombie');
      assert.equal(isPidAlive(zombie), false, 'the state probe does not');
    } finally {
      // Resume the helper and let it reap its child and exit on its own. A
      // kill right after the SIGCONT could land before it reaps, and the
      // zombie would go to PID 1, which may never reap it.
      if (helper.exitCode === null && helper.signalCode === null) {
        helper.kill('SIGCONT');
        const fallback = setTimeout(() => helper.kill('SIGKILL'), 2000);
        await once(helper, 'exit');
        clearTimeout(fallback);
      }
    }
    assert.equal(isPidRunning(zombie), false, 'the helper reaped its child before exiting');
  });
});

describe('processGroupAlive', () => {
  it('agrees with kill(-pgid, 0) for a live group, a killed one, and ids nobody holds', { skip: process.platform === 'win32' }, async () => {
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { detached: true, stdio: 'ignore' });
    await once(sleeper, 'spawn');
    const pgid = sleeper.pid!;
    try {
      assert.equal(processGroupAlive(pgid), true);
    } finally {
      process.kill(-pgid, 'SIGKILL');
      await once(sleeper, 'exit');
    }
    assert.equal(processGroupAlive(pgid), false, 'reaped by its parent, the group is gone');
    assert.equal(processGroupAlive(0), false);
    assert.equal(processGroupAlive(-5), false);
  });

  it('reads hidepid from the mount table, where hidden processes make a scan unreliable', () => {
    assert.equal(procHidesProcesses('proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n'), false);
    assert.equal(procHidesProcesses('proc /proc proc rw,relatime,hidepid=0 0 0\n'), false);
    assert.equal(procHidesProcesses('proc /proc proc rw,relatime,hidepid=off 0 0\n'), false);
    assert.equal(procHidesProcesses('proc /proc proc rw,relatime,hidepid=2 0 0\n'), true);
    assert.equal(procHidesProcesses('proc /proc proc rw,relatime,hidepid=invisible,gid=10 0 0\n'), true);
    assert.equal(procHidesProcesses('proc /other/proc proc rw,hidepid=2 0 0\nsysfs /sys sysfs rw 0 0\n'), false);
  });

  it('trusts only two scans that find the same zombies, so a child forked mid-scan is not missed', () => {
    const scripted = (...scans: GroupScan[]) => {
      let calls = 0;
      return { scan: () => scans[Math.min(calls++, scans.length - 1)], calls: () => calls };
    };
    const zombies = (...members: number[]): GroupScan => ({ members, live: false });

    // Stable: the same zombies twice.
    let run = scripted(zombies(5), zombies(5));
    assert.equal(groupHoldsOnlyZombies(run.scan), true);
    assert.equal(run.calls(), 2);

    // The race: 5 forked 6 after the first listing and then exited, so the first scan
    // read 5 as a zombie and never saw 6. The second listing finds 6 running.
    run = scripted(zombies(5), { members: [5, 6], live: true });
    assert.equal(groupHoldsOnlyZombies(run.scan), false);

    // 6 had already become a zombie by the second scan: the members changed, so a
    // third scan decides; the same set again is stable.
    run = scripted(zombies(5), zombies(5, 6), zombies(5, 6));
    assert.equal(groupHoldsOnlyZombies(run.scan), true);
    assert.equal(run.calls(), 3);

    // Members that keep changing never settle within the attempts.
    run = scripted(zombies(5), zombies(5, 6), zombies(5, 6, 7), zombies(5, 6, 7, 8), zombies(5, 6, 7, 8, 9));
    assert.equal(groupHoldsOnlyZombies(run.scan, 4), false);
    assert.equal(run.calls(), 4);

    // A live member or an unreadable one in the first scan ends it at once.
    run = scripted({ members: [5], live: true });
    assert.equal(groupHoldsOnlyZombies(run.scan), false);
    assert.equal(run.calls(), 1);
    run = scripted('unknown');
    assert.equal(groupHoldsOnlyZombies(run.scan), false);
    run = scripted(zombies(5), 'unknown');
    assert.equal(groupHoldsOnlyZombies(run.scan), false);

    // No members twice: the group went away between the signal check and the scans.
    assert.equal(groupHoldsOnlyZombies(scripted(zombies(), zombies()).scan), true);
  });

  it('counts a group holding only a zombie as gone', { skip: process.platform !== 'linux' }, async () => {
    const group = await startZombieGroup(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    try {
      assert.equal(await waitFor(() => isPidAlive(group.pgid), false), false, 'the leader became a zombie');
      assert.doesNotThrow(() => process.kill(-group.pgid, 0), 'kill(-pgid, 0) still sees the group');
      assert.equal(processGroupAlive(group.pgid), false);
    } finally {
      await group.release();
    }
  });

  it('keeps a group alive while a member still runs after its leader became a zombie', { skip: process.platform !== 'linux' }, async () => {
    // A `sh -c` wrapper that exits while what it backgrounded keeps running:
    // the leader is a zombie, the group is very much alive.
    const group = await startZombieGroup('sh', ['-c', 'sleep 30 & exit 0']);
    try {
      assert.equal(await waitFor(() => isPidAlive(group.pgid), false), false, 'the shell exited and became a zombie');
      assert.equal(processGroupAlive(group.pgid), true, 'the backgrounded sleep keeps the group alive');

      process.kill(-group.pgid, 'SIGKILL');
      assert.equal(await waitFor(() => processGroupAlive(group.pgid), false), false, 'only zombies are left once the sleep is killed');
    } finally {
      try {
        process.kill(-group.pgid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await group.release();
    }
  });
});
