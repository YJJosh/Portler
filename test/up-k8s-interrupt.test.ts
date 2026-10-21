/** A foreground `up k8s` interrupted during startup rolls back what it started, as local `up` does. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { isPidAlive, readPids } from '../src/process/pids.ts';
import { projectHash } from '../src/util/hash.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Remembers the Deployments applied, and logs every call. FAKE_KUBECTL_HANG picks the
// step that never finishes: `rollout status` (optionally ignoring signals, so only
// SIGKILL ends it) or the port-forward, which then never accepts connections.
const kubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const dir = process.env.FAKE_KUBECTL_DIR;
const hang = process.env.FAKE_KUBECTL_HANG;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const stateFile = path.join(dir, 'deployed.json');
const deployed = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
const forever = () => setInterval(() => {}, 1000);
if (args.includes('current-context')) {
  console.log('docker-desktop');
} else if (args.includes('get-contexts')) {
  console.log('docker-desktop');
} else if (args.includes('config') && args.includes('view')) {
  console.log('https://127.0.0.1:6443');
} else if (args.includes('port-forward')) {
  fs.writeFileSync(path.join(dir, 'forward.pid'), String(process.pid));
  if (hang === 'forward') forever();
  else {
    const mapping = args.find((arg) => /^\\d+:\\d+$/.test(arg));
    const server = net.createServer((socket) => socket.end());
    server.listen(Number(mapping.split(':')[0]), '127.0.0.1');
    const close = () => server.close(() => process.exit(0));
    process.on('SIGTERM', close);
    process.on('SIGINT', close);
  }
} else if (args.includes('rollout')) {
  if (hang === 'rollout' || hang === 'stubborn-rollout') {
    if (hang === 'stubborn-rollout') for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
    fs.writeFileSync(path.join(dir, 'rollout.pid'), String(process.pid));
    forever();
  }
} else if (args.includes('get') && args.includes('namespace')) {
  if (args.some((arg) => arg.includes('jsonpath'))) console.log('Active');
  else console.log(JSON.stringify({metadata: {labels: {
    'app.kubernetes.io/managed-by': 'portler',
    'portler.dev/project': process.env.FAKE_KUBECTL_PROJECT,
  }}}));
} else if (args.includes('get') && args.includes('pods')) {
  console.log(JSON.stringify({items: [{status: {
    phase: 'Running',
    conditions: [{type: 'Ready', status: 'True'}],
    containerStatuses: [{restartCount: 0}],
  }}]}));
} else if (args.includes('get') && args.includes('deployment')) {
  for (const name of deployed()) console.log('deployment.apps/' + name);
} else if (args.includes('apply')) {
  const names = new Set(deployed());
  args.forEach((arg, index) => { if (arg === '-f') names.add(path.basename(args[index + 1], '.yml')); });
  fs.writeFileSync(stateFile, JSON.stringify([...names]));
} else if (args.includes('delete')) {
  const selector = args[args.indexOf('--selector') + 1] || '';
  const match = selector.match(/app in \\(([^)]+)\\)/);
  const names = deployed();
  const removed = names.filter((name) => !match || match[1].split(',').includes(name));
  fs.writeFileSync(stateFile, JSON.stringify(names.filter((name) => !removed.includes(name))));
  for (const name of removed) console.log('deployment.apps/' + name + '\\nservice/' + name);
}
`;

async function fixture(prefix: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const projectDir = path.join(dir, 'project');
  const fakeDir = path.join(dir, 'kubectl');
  const bin = path.join(dir, 'bin');
  await Promise.all([projectDir, fakeDir, bin].map((target) => fs.mkdir(target, { recursive: true })));
  await fs.writeFile(path.join(bin, 'kubectl'), kubectl, { mode: 0o755 });
  await fs.writeFile(path.join(fakeDir, 'calls.log'), '', 'utf8');
  await fs.writeFile(
    path.join(projectDir, 'portler.yml'),
    ['port_range: {start: 57000, end: 57099}', 'services:', '  api:', '    image: example/api:latest', '    port: 8080', ''].join('\n'),
    'utf8',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    PORTLER_GLOBAL_DIR: path.join(dir, 'global'),
    FAKE_KUBECTL_DIR: fakeDir,
    FAKE_KUBECTL_PROJECT: projectHash(projectDir),
  };
  const calls = async (): Promise<string[][]> =>
    (await fs.readFile(path.join(fakeDir, 'calls.log'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  const deployed = async (): Promise<string[]> =>
    JSON.parse(await fs.readFile(path.join(fakeDir, 'deployed.json'), 'utf8').catch(() => '[]')) as string[];
  return { dir, projectDir, fakeDir, env, calls, deployed };
}

function startUp(projectDir: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'up', 'k8s'], {
    cwd: projectDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, output: '', exited: once(child, 'exit') };
  child.stdout.on('data', (chunk) => (run.output += chunk));
  child.stderr.on('data', (chunk) => (run.output += chunk));
  return run;
}

async function waitFor(file: string, run: ReturnType<typeof startUp>): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    if (await fs.access(file).then(() => true, () => false)) return;
    assert.equal(run.child.exitCode, null, `up k8s exited early:\n${run.output}`);
    await sleep(25);
  }
  assert.fail(`never reached ${path.basename(file)}:\n${run.output}`);
}

async function exitWithin(run: ReturnType<typeof startUp>, ms: number): Promise<unknown[]> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    run.exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`cancellation hung:\n${run.output}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

for (const scenario of ['rollout', 'stubborn-rollout', 'forward'] as const) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`foreground up k8s rolls back a startup interrupted during the ${scenario} on ${signal}`, { timeout: 60_000 }, async () => {
      const { dir, projectDir, fakeDir, env, calls, deployed } = await fixture('portler-k8s-interrupt-');
      env.FAKE_KUBECTL_HANG = scenario;
      const tracked = new Set<number>();
      const run = startUp(projectDir, env);
      try {
        const marker = scenario === 'forward' ? 'forward.pid' : 'rollout.pid';
        await waitFor(path.join(fakeDir, marker), run);
        const hung = Number(await fs.readFile(path.join(fakeDir, marker), 'utf8'));
        tracked.add(hung);
        for (const info of Object.values((await readPids(projectDir))?.services ?? {})) tracked.add(info.pid);
        if (scenario === 'forward') assert.ok(tracked.size > 1, `the port-forward supervisor was recorded:\n${run.output}`);
        assert.deepEqual(await deployed(), ['api']);

        run.child.kill(signal);
        assert.deepEqual(await exitWithin(run, 15_000), [signal === 'SIGINT' ? 130 : 143, null], run.output);

        const deletes = (await calls()).filter((call) => call.includes('delete'));
        assert.equal(deletes.length, 1, JSON.stringify(deletes));
        assert.match(deletes[0]![deletes[0]!.indexOf('--selector') + 1]!, /,app in \(api\)$/);
        assert.deepEqual(await deployed(), [], 'what this run applied is deleted');
        for (const pid of tracked) assert.equal(isPidAlive(pid), false, `owned process ${pid} stopped:\n${run.output}`);
        assert.deepEqual(Object.keys((await readPids(projectDir))?.services ?? {}), [], run.output);
        const registry = JSON.parse(await fs.readFile(path.join(dir, 'global', 'ports.json'), 'utf8'));
        assert.deepEqual(registry.ports, {}, 'startup reservations released');
        await assert.rejects(fs.access(path.join(projectDir, '.portler', 'lifecycle.lock')), 'rollback released the lifecycle lock');
      } finally {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill('SIGKILL');
          await run.exited;
        }
        for (const info of Object.values((await readPids(projectDir).catch(() => null))?.services ?? {})) tracked.add(info.pid);
        for (const pid of tracked) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already stopped.
          }
        }
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
}

it('foreground up k8s stops waiting for a held lifecycle lock on SIGINT', { timeout: 20_000 }, async () => {
  const { dir, projectDir, env, calls } = await fixture('portler-k8s-interrupt-lock-');
  const run = startUp(projectDir, env);
  try {
    // Another live command (this test process) holds the lock.
    const lockDir = path.join(projectDir, '.portler', 'lifecycle.lock');
    await fs.mkdir(lockDir, { recursive: true });
    const owner = { pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token: 'held-by-test' };
    await fs.writeFile(path.join(lockDir, 'owner'), JSON.stringify(owner));
    // Long enough for the CLI to check the cluster and start waiting.
    await sleep(2_000);
    assert.equal(run.child.exitCode, null, run.output);
    const sentAt = Date.now();
    run.child.kill('SIGINT');
    assert.deepEqual(await exitWithin(run, 5_000), [130, null], run.output);
    assert.ok(Date.now() - sentAt < 3_000, 'exits promptly');
    assert.deepEqual((await calls()).filter((call) => call.includes('apply') || call.includes('delete')), []);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(lockDir, 'owner'), 'utf8')), owner, 'the holder keeps its lock');
  } finally {
    if (run.child.exitCode === null && run.child.signalCode === null) {
      run.child.kill('SIGKILL');
      await run.exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
