/** Startup cancellation must roll back under the lifecycle lock, not just exit. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { isPidAlive, readPids } from '../src/process/pids.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const scenario of ['http', 'hanging-http', 'command', 'interval', 'project-setup', 'service-setup'] as const) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`foreground up rolls back ${scenario} startup on ${signal}`, { timeout: 20_000 }, async () => {
      const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-interrupt-')));
      const globalDir = path.join(dir, 'global');
      const env = { ...process.env, PORTLER_GLOBAL_DIR: globalDir };
      const tracked = new Set<number>();
      const setup = scenario.endsWith('setup');
      const node = `exec "${process.execPath}"`;
      let output = '';
      let child: ReturnType<typeof spawn> | undefined;
      try {
        await fs.writeFile(path.join(dir, 'server.cjs'), `
          require('node:http').createServer((req, res) => {
            require('node:fs').writeFileSync('probed', 'yes');
            ${scenario === 'hanging-http' ? '' : 'res.writeHead(401); res.end();'}
          }).listen(Number(process.env.PORT), '127.0.0.1', () => require('node:fs').writeFileSync('listening', 'yes'));
        `);
        await fs.writeFile(path.join(dir, 'step.cjs'), `
          const fs = require('node:fs');
          // A setup command ignoring cancellation must not hang rollback forever.
          for (const signal of ['SIGINT', 'SIGTERM']) {
            process.on(signal, () => fs.appendFileSync('signals', signal + '\\n'));
          }
          fs.writeFileSync('step.pid', String(process.pid));
          setInterval(() => {}, 1000);
        `);
        const step = `\n    setup:\n      - ${node} step.cjs\n      - touch should-not-run`;
        await fs.writeFile(path.join(dir, 'portler.yml'), `
${scenario === 'project-setup' ? `setup:\n  - ${node} step.cjs\n  - touch should-not-run` : ''}
services:
  unrelated:
    command: ${node} -e 'setInterval(() => {}, 1000)'
  first:
    command: ${node} -e 'setInterval(() => {}, 1000)'
    port: 18371
    healthcheck: {type: none}
  backend:
    command: ${node} server.cjs
    port: 18372
    port_env: PORT
    depends_on: [first]
${scenario === 'service-setup' ? step : ''}
    healthcheck:
      type: ${scenario === 'command' ? 'command' : 'http'}
      ${scenario === 'command' ? `command: ${node} step.cjs` : 'url: "${backend.url}"'}
      timeout_ms: 60000
      interval_ms: ${scenario === 'interval' ? 60000 : 100}
`);
        // A separate run is not part of the interrupted stack.
        const prior = spawn(process.execPath, [cli, 'up', 'unrelated', '-d', '--no-setup'], { cwd: dir, env, stdio: 'pipe' });
        assert.equal((await once(prior, 'exit'))[0], 0);
        const unrelated = (await readPids(dir))!.services.unrelated!;
        tracked.add(unrelated.pid);

        child = spawn(process.execPath, [cli, 'up', 'backend'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout!.on('data', (chunk) => { output += chunk; });
        child.stderr!.on('data', (chunk) => { output += chunk; });
        const exited = once(child, 'exit');
        const marker = setup || scenario === 'command' ? 'step.pid' : scenario === 'interval' ? 'listening' : 'probed';
        let reached = false;
        for (let i = 0; i < 200; i++) {
          reached = await fs.access(path.join(dir, marker)).then(() => true, () => false);
          if (reached) break;
          await sleep(25);
        }
        assert.ok(reached, output);
        if (marker === 'step.pid') tracked.add(Number(await fs.readFile(path.join(dir, marker), 'utf8')));
        const before = (await readPids(dir))!;
        for (const info of Object.values(before.services)) tracked.add(info.pid);
        if (scenario === 'interval') await sleep(100);
        child.kill(signal);
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`cancellation hung: ${output}`)), 8000); }),
        ]).finally(() => clearTimeout(timer));
        assert.deepEqual(result, [signal === 'SIGINT' ? 130 : 143, null], output);
        assert.match(output, /startup failed.*releasing allocated ports/);
        const after = await readPids(dir);
        assert.deepEqual(Object.keys(after?.services ?? {}), ['unrelated'], output);
        assert.ok(isPidAlive(unrelated.pid), 'does not stop a service from another run');
        for (const pid of tracked) {
          if (pid !== unrelated.pid) assert.equal(isPidAlive(pid), false, `owned process ${pid} stopped`);
        }
        const registry = JSON.parse(await fs.readFile(path.join(globalDir, 'ports.json'), 'utf8'));
        assert.deepEqual(registry.ports, {}, 'startup reservations released');
        await assert.rejects(fs.access(path.join(dir, 'should-not-run')));
        if (setup) {
          assert.equal(await fs.readFile(path.join(dir, 'signals'), 'utf8'), signal + '\n', 'setup receives the original signal exactly once');
          const receipts = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
          const key = scenario === 'project-setup' ? 'local:dev:project' : 'local:dev:service:backend';
          assert.deepEqual(receipts.steps[key] ?? [], [], 'cancelled setup is not receipted');
        }
        await assert.rejects(fs.access(path.join(dir, '.portler/lifecycle.lock')), 'rollback released the lifecycle lock');
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
        for (const info of Object.values((await readPids(dir))?.services ?? {})) tracked.add(info.pid);
        const stepPid = await fs.readFile(path.join(dir, 'step.pid'), 'utf8').catch(() => '');
        if (stepPid) tracked.add(Number(stepPid));
        for (const pid of tracked) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* Already stopped. */ }
        }
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
}
