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

  it('records an --image pin on the port-forward entry, so env can rebuild state from it', async () => {
    assert.equal(await commandUp(parseArgs(['k8s', '--detach', '--image', 'api=example/api@sha256:pinned'], 'up')), 0);
    const pids = await readPids(projectDir);
    assert.equal(pids?.services.api?.image, 'example/api@sha256:pinned');
    assert.equal(pids?.services.api?.runMode, 'k8s');
    await stopServices(projectDir);
    await releasePorts(projectDir);
  });
});

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
  console.log(process.env.FAKE_KUBECTL_CONTEXT || 'docker-desktop');
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
} else if (args.includes('rollout') && args.includes('deployment/' + process.env.FAKE_KUBECTL_HANG_ROLLOUT)) {
  setInterval(() => {}, 1000);
} else if (args.includes('get') && args.includes('deployment')) {
  for (const name of load()) console.log('deployment.apps/' + name);
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
const cliEnv = (stateFile: string, callsFile: string, context = 'docker-desktop'): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_KUBECTL_CONTEXT: context,
  FAKE_KUBECTL_STATE: stateFile,
  FAKE_KUBECTL_CALLS: callsFile,
  FAKE_KUBECTL_PROJECT: projectHash(projectDir),
});

describe('foreground teardown after the config grew (fake kubectl)', () => {
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

describe('the kubectl context of the launch (fake kubectl)', () => {
  const config = [
    'port_range: {start: 56100, end: 56199}',
    'services:',
    '  api:',
    '    image: example/api:latest',
    '    port: 8080',
    '  worker:',
    '    image: example/worker:latest',
    '',
  ].join('\n');

  const savedContext = async (): Promise<string | undefined> => {
    const file = path.join(projectDir, '.portler', 'k8s-context.json');
    return fs.readFile(file, 'utf8').then((text) => (JSON.parse(text) as { context: string }).context, () => undefined);
  };

  /** The --context of every recorded kubectl call that contains `verb`. */
  const contextsOf = async (callsFile: string, verb: string): Promise<string[]> =>
    (await fs.readFile(callsFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((call) => call.includes(verb))
      .map((call) => call[call.indexOf('--context') + 1]!);

  const portler = (env: NodeJS.ProcessEnv, ...args: string[]) =>
    spawnSync(process.execPath, ['--experimental-strip-types', cli(), ...args], { cwd: projectDir, env, encoding: 'utf8', timeout: 60_000 });

  it('env and down k8s use the context up k8s deployed to, not the one active after a switch', async () => {
    const stateFile = path.join(tempDir, 'objects.json');
    const callsFile = path.join(tempDir, 'calls.log');
    await fs.writeFile(path.join(tempDir, 'bin', 'kubectl'), statefulKubectl, { mode: 0o755 });
    await fs.writeFile(path.join(projectDir, 'portler.yml'), config, 'utf8');

    const up = portler(cliEnv(stateFile, callsFile), 'up', 'k8s', '--detach');
    assert.equal(up.status, 0, `${up.stdout}\n${up.stderr}`);
    assert.equal(await savedContext(), 'docker-desktop');

    const switched = cliEnv(stateFile, callsFile, 'kind-other');
    await fs.writeFile(callsFile, '');
    // worker has no port, so no port-forward and no entry: only the cluster knows it runs.
    const env = portler(switched, 'env', 'worker');
    assert.equal(env.status, 0, env.stderr);
    assert.match(env.stderr, /worker was started with "portler up k8s"/);
    assert.deepEqual(await contextsOf(callsFile, 'deployment'), ['docker-desktop']);

    const down = portler(switched, 'down', 'k8s');
    assert.equal(down.status, 0, `${down.stdout}\n${down.stderr}`);
    assert.match(down.stdout, /kubectl context: docker-desktop/);
    const deletes = await contextsOf(callsFile, 'delete');
    assert.ok(deletes.length > 0);
    assert.deepEqual([...new Set(deletes)], ['docker-desktop']);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), []);
    assert.equal(await savedContext(), undefined, 'a full down forgets the context');
  });

  it('refuses up k8s on another context while the project still runs on the saved one', async () => {
    const stateFile = path.join(tempDir, 'objects.json');
    const callsFile = path.join(tempDir, 'calls.log');
    await fs.writeFile(path.join(tempDir, 'bin', 'kubectl'), statefulKubectl, { mode: 0o755 });
    await fs.writeFile(path.join(projectDir, 'portler.yml'), config, 'utf8');

    const first = portler(cliEnv(stateFile, callsFile), 'up', 'k8s', 'worker', '--detach');
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    const switched = cliEnv(stateFile, callsFile, 'kind-other');
    const refused = portler(switched, 'up', 'k8s', 'api', '--detach');
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /still runs worker on kubectl context "docker-desktop"/);
    assert.equal(await savedContext(), 'docker-desktop');
    assert.equal(await contextsOf(callsFile, 'apply').then((contexts) => contexts.includes('kind-other')), false);

    // Once it is down there, the other context is free to use.
    assert.equal(portler(switched, 'down', 'k8s').status, 0);
    const second = portler(switched, 'up', 'k8s', 'api', '--detach');
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(await savedContext(), 'kind-other');
  });
});

describe('Ctrl-C during up k8s startup (fake kubectl)', () => {
  it('rolls back what the run started when interrupted while a rollout is still waiting', async () => {
    const stateFile = path.join(tempDir, 'objects.json');
    const callsFile = path.join(tempDir, 'calls.log');
    await fs.writeFile(path.join(tempDir, 'bin', 'kubectl'), statefulKubectl, { mode: 0o755 });
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      [
        'port_range: {start: 56200, end: 56299}',
        'services:',
        '  db:',
        '    image: example/db:latest',
        '    port: 5432',
        '  api:',
        '    image: example/api:latest',
        '    port: 8080',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      'utf8',
    );

    let output = '';
    const foreground = spawn(process.execPath, ['--experimental-strip-types', cli(), 'up', 'k8s'], {
      cwd: projectDir,
      // api's rollout never finishes, so the run is still starting when the signal comes.
      env: { ...cliEnv(stateFile, callsFile), FAKE_KUBECTL_HANG_ROLLOUT: 'api' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    foreground.stdout.on('data', (chunk) => (output += chunk));
    foreground.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => foreground.once('exit', resolve));

    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const calls = await fs.readFile(callsFile, 'utf8').catch(() => '');
        if (calls.includes('"deployment/api"')) break;
        assert.equal(foreground.exitCode, null, `up k8s exited early:\n${output}`);
        assert.ok(Date.now() < deadline, `up k8s never reached api's rollout:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      // db is up behind its port-forward; api is applied and rolling out.
      assert.deepEqual(Object.keys((await readPids(projectDir))?.services ?? {}), ['db']);

      // Only Portler gets the signal (as from `kill`), not the hanging kubectl next to it.
      foreground.kill('SIGINT');
      assert.equal(await exited, 130, output);
    } finally {
      if (foreground.exitCode === null && foreground.signalCode === null) foreground.kill('SIGKILL');
    }

    assert.match(output, /received SIGINT, stopping services/);
    const deletes = (await fs.readFile(callsFile, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((call) => call.includes('delete'));
    assert.equal(deletes.length, 1, JSON.stringify(deletes));
    assert.match(deletes[0]![deletes[0]!.indexOf('--selector') + 1]!, /,app in \(db,api\)$/);
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile, 'utf8')), []);
    assert.equal(await readPids(projectDir).then((pids) => Object.keys(pids?.services ?? {}).length), 0);
    const registry = JSON.parse(await fs.readFile(path.join(tempDir, 'global', 'ports.json'), 'utf8')) as {
      ports: Record<string, { project: string }>;
    };
    assert.deepEqual(Object.values(registry.ports).filter((entry) => entry.project === projectDir), []);
  });
});
