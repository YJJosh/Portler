import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandUp } from '../src/cli/commands/up.ts';
import { releasePorts } from '../src/ports/index.ts';
import { readPids, stopServices } from '../src/process/index.ts';
import { readState } from '../src/state/index.ts';
import { projectHash } from '../src/util/hash.ts';

let tempDir: string;
let projectDir: string;
let previousCwd: string;
let previousPath: string;
let previousEntrypoint: string | undefined;
let previousGlobalDir: string | undefined;

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-up-k8s-'));
  projectDir = path.join(tempDir, 'project');
  const binDir = path.join(tempDir, 'bin');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  // macOS exposes /var through /private/var; match process.cwd() and the
  // project identity Portler records instead of comparing lexical aliases.
  projectDir = await fs.realpath(projectDir);

  await fs.writeFile(
    path.join(projectDir, 'portler.yml'),
    [
      'port_range: {start: 55000, end: 55999}',
      'services:',
      '  api:',
      '    image: example/api:latest',
      '    port: 8080',
      '    k8s: true',
      'proxy:',
      '  routes:',
      '    /: api',
      '',
    ].join('\n'),
    'utf8',
  );

  // This executable is the only kubectl visible to the test. It models a local
  // Docker Desktop context, a missing namespace, stable pods, and a real local
  // TCP listener for `kubectl port-forward`; no cluster or Docker daemon is used.
  const kubectl = `#!/usr/bin/env node
const net = require('node:net');
const args = process.argv.slice(2);
if (args[0] === 'config' && args[1] === 'current-context') {
  console.log('docker-desktop');
  process.exit(0);
}
if (args[0] === 'config' && args[1] === 'view') {
  console.log('https://127.0.0.1:6443');
  process.exit(0);
}
if (args.includes('port-forward')) {
  const mapping = args.find((arg) => /^\\d+:\\d+$/.test(arg));
  const localPort = Number(mapping.split(':')[0]);
  const addressAt = args.indexOf('--address');
  const host = addressAt === -1 ? '127.0.0.1' : args[addressAt + 1];
  const server = net.createServer((socket) => socket.end());
  server.listen(localPort, host);
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} else if (args.includes('get') && args.includes('pods')) {
  console.log(JSON.stringify({items: [{status: {
    phase: 'Running',
    conditions: [{type: 'Ready', status: 'True'}],
    containerStatuses: [{restartCount: 0}],
  }}]}));
  process.exit(0);
} else if (args.includes('get') && args.includes('namespace')) {
  console.error('Error from server (NotFound): namespaces "portler-test" not found');
  process.exit(1);
} else {
  process.exit(0);
}
`;
  await fs.writeFile(path.join(binDir, 'kubectl'), kubectl, { mode: 0o755 });

  previousCwd = process.cwd();
  previousPath = process.env.PATH ?? '';
  previousEntrypoint = process.argv[1];
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
  process.chdir(projectDir);
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
  process.env.PORTLER_GLOBAL_DIR = path.join(tempDir, 'global');
  // spawnPortForward re-execs the active Portler entrypoint. Tests normally put
  // the test file here, so point it at the real (TypeScript) CLI explicitly.
  process.argv[1] = path.resolve(previousCwd, 'bin/portler.ts');
});

afterEach(async () => {
  try {
    const pids = await readPids(projectDir).catch(() => null);
    if (pids && Object.keys(pids.services).length > 0) await stopServices(projectDir, undefined, { force: true });
    await releasePorts(projectDir).catch(() => {});
  } finally {
    process.chdir(previousCwd);
    process.env.PATH = previousPath;
    if (previousEntrypoint === undefined) delete process.argv[1];
    else process.argv[1] = previousEntrypoint;
    if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
    else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe('Kubernetes proxy lifecycle (fake kubectl)', () => {
  it('starts and records the host proxy after the port-forward is ready', async () => {
    assert.equal(await commandUp(parseArgs(['k8s', '--detach'], 'up')), 0);

    const pids = await readPids(projectDir);
    assert.deepEqual(Object.keys(pids?.services ?? {}).sort(), ['api', 'proxy']);

    const state = await readState(projectDir);
    assert.ok(state?.services.api);
    assert.ok(state?.services.proxy);
    assert.equal(await canConnect(state!.services.api!.port), true, 'fake Kubernetes port-forward should be live');
    assert.equal(await canConnect(state!.services.proxy!.port), true, 'host reverse proxy should be live');

    const stopped = await stopServices(projectDir);
    assert.deepEqual(stopped.unverified, []);
    assert.deepEqual(stopped.failures, []);
    assert.deepEqual(stopped.completed.sort(), ['api', 'proxy']);
    await releasePorts(projectDir);
  });
});

describe('foreground teardown after the config grew (fake kubectl)', () => {
  // A fake kubectl that remembers which Deployments were applied and honours
  // `delete --selector`, so what a teardown removes can be read back from it.
  const statefulKubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_KUBECTL_STATE;
const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
fs.appendFileSync(process.env.FAKE_KUBECTL_CALLS, JSON.stringify(args) + '\\n');
if (args.includes('config') && args.includes('current-context')) {
  console.log('docker-desktop');
} else if (args.includes('config') && args.includes('view')) {
  console.log('https://127.0.0.1:6443');
} else if (args.includes('port-forward')) {
  const mapping = args.find((arg) => /^\\d+:\\d+$/.test(arg));
  const server = net.createServer((socket) => socket.end());
  server.listen(Number(mapping.split(':')[0]), '127.0.0.1');
  const close = () => server.close(() => process.exit(0));
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
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
} else if (args.includes('apply')) {
  const objects = new Set(load());
  args.forEach((arg, index) => { if (arg === '-f') objects.add(path.basename(args[index + 1], '.yml')); });
  fs.writeFileSync(stateFile, JSON.stringify([...objects]));
} else if (args.includes('delete')) {
  const selector = args[args.indexOf('--selector') + 1] || '';
  const match = selector.match(/app in \\(([^)]+)\\)/);
  const objects = load();
  const removed = objects.filter((name) => !match || match[1].split(',').includes(name));
  fs.writeFileSync(stateFile, JSON.stringify(objects.filter((name) => !removed.includes(name))));
  for (const name of removed) console.log('deployment.apps/' + name + '\\nservice/' + name);
}
`;

  const cli = (): string => path.resolve(previousCwd, 'bin/portler.ts');
  const cliEnv = (stateFile: string, callsFile: string): NodeJS.ProcessEnv => ({
    ...process.env,
    FAKE_KUBECTL_STATE: stateFile,
    FAKE_KUBECTL_CALLS: callsFile,
    FAKE_KUBECTL_PROJECT: projectHash(projectDir),
  });

  it('leaves a newer run\'s services alone when a foreground run that selected the whole config is interrupted', async () => {
    const binDir = path.join(tempDir, 'bin');
    const stateFile = path.join(tempDir, 'objects.json');
    const callsFile = path.join(tempDir, 'calls.log');
    await fs.writeFile(path.join(binDir, 'kubectl'), statefulKubectl, { mode: 0o755 });
    const env = cliEnv(stateFile, callsFile);
    const config = ['port_range: {start: 56000, end: 56099}', 'services:', '  api:', '    image: example/api:latest', '    port: 8080', ''].join('\n');
    await fs.writeFile(path.join(projectDir, 'portler.yml'), config, 'utf8');

    // `up k8s` with no names starts every service the config has right now: api.
    let output = '';
    const foreground = spawn(process.execPath, ['--experimental-strip-types', cli(), 'up', 'k8s'], {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    foreground.stdout.on('data', (chunk) => (output += chunk));
    foreground.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => foreground.once('exit', resolve));

    try {
      const deadline = Date.now() + 30_000;
      while (!output.includes('verified 1 port-forward')) {
        assert.equal(foreground.exitCode, null, `foreground run exited early:\n${output}`);
        assert.ok(Date.now() < deadline, `foreground run never became ready:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // The config grows, and a newer detached run takes the new service.
      await fs.writeFile(path.join(projectDir, 'portler.yml'), `${config}  worker:\n    image: example/worker:latest\n    port: 8081\n`, 'utf8');
      const detached = spawnSync(process.execPath, ['--experimental-strip-types', cli(), 'up', 'k8s', 'worker', '--detach'], {
        cwd: projectDir,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.equal(detached.status, 0, `${detached.stdout}\n${detached.stderr}`);
      assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')).sort(), ['api', 'worker']);

      foreground.kill('SIGINT');
      assert.equal(await exited, 130, output);
    } finally {
      if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGKILL');
    }

    const deletes = (await fs.readFile(callsFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((call) => call.includes('delete'));
    assert.equal(deletes.length, 1, JSON.stringify(deletes));
    assert.match(deletes[0]![deletes[0]!.indexOf('--selector') + 1]!, /,app in \(api\)$/);

    // The newer run still owns worker: its Deployment and its recorded forward.
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), ['worker']);
    const pids = await readPids(projectDir);
    assert.deepEqual(Object.keys(pids?.services ?? {}), ['worker']);
  });
});
