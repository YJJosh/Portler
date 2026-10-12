import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { isPidAlive, isPidRunning } from '../src/process/pids.ts';

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
    try {
      const [chunk] = await once(helper.stdout!, 'data');
      const zombie = Number(String(chunk).trim());
      assert.ok(zombie > 0, `helper reported pid ${String(chunk)}`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(isPidRunning(zombie), true, 'kill(pid, 0) still sees the zombie');
      assert.equal(isPidAlive(zombie), false, 'the state probe does not');
    } finally {
      helper.kill('SIGCONT');
      helper.kill('SIGKILL');
    }
  });
});
