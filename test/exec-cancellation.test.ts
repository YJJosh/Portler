import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { captureOutput, runStreaming } from '../src/k8s/exec.ts';
import { readProcessStartToken } from '../src/process/identity.ts';
import { isPidAlive } from '../src/process/pids.ts';
import { runCommand } from '../src/util/exec.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const runners = {
  runCommand: (args: string[], signal: AbortSignal) => runCommand(process.execPath, args, undefined, signal),
  captureOutput: (args: string[], signal: AbortSignal) => captureOutput(process.execPath, args, signal),
  runStreaming: (args: string[], signal: AbortSignal) => runStreaming(process.execPath, args, 'test', undefined, signal),
};

// REVIEW: Real kubectl credential/build helpers can inherit pipes OR close them and
// keep running. Cancel the owned group in both cases, even when its leader exits first.
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
