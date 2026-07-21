import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandUp } from '../src/cli/commands/up.ts';
import { releasePorts } from '../src/ports/index.ts';
import { readPids, stopServices } from '../src/process/index.ts';
import { readState } from '../src/state/index.ts';

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
