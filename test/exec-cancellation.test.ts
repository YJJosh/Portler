import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { captureOutput, runStreaming } from '../src/k8s/exec.ts';
import { readProcessStartToken } from '../src/process/identity.ts';
import { isPidAlive } from '../src/process/pids.ts';
import { drainOwnedProcessGroup, signalOwnedProcessGroup } from '../src/process/shell.ts';
import { runCommand } from '../src/util/exec.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runners = {
  runCommand: (args: string[], signal: AbortSignal) => runCommand(process.execPath, args, undefined, signal),
  captureOutput: (args: string[], signal: AbortSignal) => captureOutput(process.execPath, args, signal),
  runStreaming: (args: string[], signal: AbortSignal) => runStreaming(process.execPath, args, 'test', undefined, signal),
};

// A kubectl credential helper or a build helper may inherit the pipes, or close them and
// keep running. Cancelling must stop it either way, even when its leader exits first.
for (const [name, run] of Object.entries(runners)) {
  for (const pipes of ['inherit', 'ignore']) {
    it(`${name} cancellation drains a stubborn helper with ${pipes} stdio`, { timeout: 15_000 }, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-exec-cancel-'));
      const marker = path.join(dir, 'helper.json');
      const controller = new AbortController();
      const helper = `
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, leader: process.ppid}));
        setInterval(() => {}, 1000);
      `;
      const leader = `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio: ${JSON.stringify(pipes)}});
        setInterval(() => {}, 1000);
      `;
      const pending = run(['-e', leader], controller.signal);
      // Observe rejections immediately: failure to start is not an unhandled rejection.
      void pending.catch(() => {});
      const tracked: Array<{ pid: number; token: string | null }> = [];
      let timer: NodeJS.Timeout | undefined;
      try {
        const deadline = Date.now() + 5_000;
        while (!await fs.access(marker).then(() => true, () => false)) {
          assert.ok(Date.now() < deadline, 'helper reached its signal handlers');
          await pause(20);
        }
        const info = JSON.parse(await fs.readFile(marker, 'utf8')) as { pid: number; leader: number };
        for (const pid of [info.leader, info.pid]) tracked.push({ pid, token: await readProcessStartToken(pid) });
        controller.abort('SIGTERM');
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('cancelled command hung on helper')), 7_000);
        });
        await assert.rejects(Promise.race([pending, timeout]), (reason: unknown) => reason === 'SIGTERM');
        assert.equal(isPidAlive(info.leader), false, 'leader stopped');
        assert.equal(isPidAlive(info.pid), false, 'helper stopped before cancellation settled');
      } finally {
        clearTimeout(timer);
        controller.abort('SIGTERM');
        for (const { pid, token } of tracked) {
          if (token !== null && await readProcessStartToken(pid) === token) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* Already stopped. */ }
          }
        }
        await pending.catch(() => {});
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
}

// REVIEW: macOS answers kill(-pgid) with EPERM once every member of the group is a zombie,
// as a just-killed helper is until its reaper gets to it. Draining (and signalling) such a
// group must not throw: from an abort listener or timer that ended Portler before rollback.
it('drains an owned group left holding only an unreaped zombie', { timeout: 15_000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-exec-zombie-'));
  const marker = path.join(dir, 'reaper.pid');
  // The perl process forks a child that exits at once, then leaves the group with setsid
  // and never reaps it: the group keeps a zombie member and nothing else.
  const perl = `use POSIX; my $z = fork(); POSIX::_exit(0) if $z == 0; POSIX::setsid() or die; ` +
    `open(my $f, '>', $ARGV[0]) or die; print $f $$; close $f; sleep 30;`;
  const leaderScript = `
    const fs = require('node:fs');
    require('node:child_process').spawn('perl', ['-e', ${JSON.stringify(perl)}, ${JSON.stringify(marker)}], { stdio: 'ignore' }).unref();
    const wait = () => (fs.existsSync(${JSON.stringify(marker)}) ? process.exit(0) : setTimeout(wait, 20));
    wait();
  `;
  const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: 'ignore' });
  let reaper: number | undefined;
  try {
    await new Promise((resolve) => leader.once('exit', resolve));
    reaper = Number(await fs.readFile(marker, 'utf8'));
    await drainOwnedProcessGroup(leader.pid!, 100);
    assert.doesNotThrow(() => signalOwnedProcessGroup(leader.pid!, 'SIGKILL'));
  } finally {
    if (reaper) {
      try { process.kill(reaper, 'SIGKILL'); } catch { /* Already gone. */ }
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
