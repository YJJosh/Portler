import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { validateK8sForwards } from '../src/cli/commands/up-k8s.ts';
import { ensureAssignments } from '../src/cli/commands/env.ts';
import { loadConfig } from '../src/config/loader.ts';
import { serviceManifests } from '../src/k8s/manifests.ts';
import { allocateAssignments } from '../src/ports/allocate.ts';
import { isPortFree } from '../src/ports/probe.ts';
import { pruneRegistry, readRegistry } from '../src/ports/registry.ts';
import { dockerShellCommand } from '../src/process/docker.ts';
import type { Assignments, PortlerConfig, ServiceConfig, StateFile } from '../src/types/index.ts';

const tempDirs: string[] = [];
let previousGlobalDir: string | undefined;

beforeEach(async () => {
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-registry-'));
  tempDirs.push(dir);
  process.env.PORTLER_GLOBAL_DIR = dir;
});

afterEach(async () => {
  if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
  else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeProject(yaml: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-project-'));
  tempDirs.push(dir);
  await fs.writeFile(path.join(dir, 'portler.yml'), yaml, 'utf8');
  return dir;
}

function makeService(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    name: 'game',
    cwd: '.',
    portEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    preferDeclaredPort: false,
    dependsOn: [],
    ...overrides,
  };
}

function makeConfig(projectDir: string, services: ServiceConfig[]): PortlerConfig {
  return {
    filePath: path.join(projectDir, 'portler.yml'),
    projectDir,
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 53300, end: 53999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: projectDir,
    volumes: [],
    k8sNamespace: 'portler-test',
    services: Object.fromEntries(services.map((service) => [service.name, service])),
  };
}

function occupyUdpPort(host = '127.0.0.1'): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    socket.on('error', (error) => { socket.close(); reject(error); });
    socket.bind(0, host, () => {
      resolve({ port: socket.address().port, close: () => new Promise((done) => socket.close(() => done())) });
    });
  });
}

describe('transport in portler.yml', () => {
  it('reads udp and tcp+udp, and leaves plain services without a transport', async () => {
    const dir = await makeProject(
      [
        'services:',
        '  bedrock:',
        '    image: itzg/minecraft-bedrock-server',
        '    port: 19132',
        '    transport: udp',
        '  satisfactory:',
        '    image: wolveix/satisfactory-server',
        '    port: 7777',
        '    transport: tcp+udp',
        '  web:',
        '    command: node server.js',
        '    port: 3000',
        '',
      ].join('\n'),
    );
    const config = await loadConfig(dir);
    assert.equal(config.services.bedrock!.transport, 'udp');
    assert.equal(config.services.satisfactory!.transport, 'tcp+udp');
    assert.equal(config.services.web!.transport, undefined);
  });

  it('rejects an unknown transport and a transport without a port', async () => {
    const unknown = await makeProject('services:\n  game:\n    command: run\n    port: 1\n    transport: sctp\n');
    await assert.rejects(loadConfig(unknown), /services\.game\.transport must be one of: tcp, udp, tcp\+udp/);
    const portless = await makeProject('services:\n  game:\n    command: run\n    transport: udp\n');
    await assert.rejects(loadConfig(portless), /services\.game\.transport requires services\.game\.port/);
  });

  it('rejects TCP checks and proxy routes on a UDP-only port', async () => {
    const tcpCheck = await makeProject('services:\n  game:\n    command: run\n    port: 1\n    transport: udp\n    healthcheck: tcp\n');
    await assert.rejects(loadConfig(tcpCheck), /checks the port over TCP/);
    const proxied = await makeProject(
      'proxy:\n  routes:\n    /: game\nservices:\n  game:\n    command: run\n    port: 1\n    transport: udp\n',
    );
    await assert.rejects(loadConfig(proxied), /UDP only; the proxy forwards HTTP over TCP/);
    const commandCheck = await makeProject(
      'services:\n  game:\n    command: run\n    port: 1\n    transport: udp\n    healthcheck:\n      command: "true"\n',
    );
    assert.equal((await loadConfig(commandCheck)).services.game!.healthcheck?.type, 'command');
  });
});

describe('isPortFree with transports', () => {
  // REVIEW: Exercise IPv6 DNS resolution as well as literal/wildcard addresses;
  // the original tests used only IPv4 literals and missed the family mismatch.
  it('probes IPv6-only hostnames using an IPv6 socket', async (t) => {
    let bound;
    try {
      bound = await occupyUdpPort('::1');
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('IPv6 loopback is unavailable');
        return;
      }
      throw error;
    }
    const lookup = dns.lookup;
    t.mock.method(dns, 'lookup', async (host: string) =>
      host === 'ipv6-service.test' ? { address: '::1', family: 6 } : lookup(host),
    );
    const { port, close } = bound;
    try {
      assert.equal(await isPortFree(port, '::1', 'udp'), false);
      assert.equal(await isPortFree(port, 'ipv6-service.test', 'udp'), false);
    } finally {
      await close();
    }
    assert.equal(await isPortFree(port, '::1', 'udp'), true);
    assert.equal(await isPortFree(port, 'ipv6-service.test', 'udp'), true);
    assert.equal(await isPortFree(port, '::1', 'tcp+udp'), true);
  });

  it('detects wildcard UDP listeners and treats lookup failures as unavailable', async () => {
    const { port, close } = await occupyUdpPort('0.0.0.0');
    try {
      assert.equal(await isPortFree(port, '127.0.0.1', 'udp'), false);
      assert.equal(await isPortFree(port, '0.0.0.0', 'udp'), false);
      assert.equal(await isPortFree(port, 'localhost', 'udp'), false);
    } finally {
      await close();
    }
    assert.equal(await isPortFree(port, 'does-not-exist.invalid', 'udp'), false);
  });

  it('checks UDP separately from TCP, and tcp+udp needs both', async () => {
    const { port, close } = await occupyUdpPort();
    try {
      assert.equal(await isPortFree(port, '127.0.0.1', 'udp'), false);
      assert.equal(await isPortFree(port, '127.0.0.1', 'tcp+udp'), false);
      assert.equal(await isPortFree(port, '127.0.0.1', 'tcp'), true);
    } finally {
      await close();
    }
    assert.equal(await isPortFree(port, '127.0.0.1', 'udp'), true);
  });
});

describe('allocateAssignments with UDP', () => {
  // REVIEW: An env allocation cached by an older/TCP config may now be busy on
  // UDP. A transport edit must invalidate that cache for stopped services.
  it('refreshes env assignments when a cached TCP service changes transport', async () => {
    const yaml = 'services:\n  game:\n    command: run\n    port: 19132\n';
    const dir = await makeProject(yaml);
    const before = await ensureAssignments(await loadConfig(dir));
    const port = before.assignments.game!.port;
    const socket = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, '127.0.0.1', resolve);
    });
    try {
      await fs.writeFile(path.join(dir, 'portler.yml'), `${yaml}    transport: udp\n`);
      const after = await ensureAssignments(await loadConfig(dir));
      assert.notEqual(after.assignments.game!.port, port);
      assert.equal(after.assignments.game!.transport, 'udp');
      assert.equal((await readRegistry()).ports[String(after.assignments.game!.port)]?.transport, 'udp');
    } finally {
      await new Promise<void>((resolve) => socket.close(resolve));
    }
  });

  it('skips a previous port that is busy on UDP and records the transport', async () => {
    const { port: busy, close } = await occupyUdpPort();
    try {
      const config = makeConfig('/project-udp', [makeService({ port: 19132, transport: 'udp' })]);
      const state: StateFile = {
        version: 1,
        project: '/project-udp',
        updatedAt: new Date().toISOString(),
        services: {
          game: { name: 'game', port: busy, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: `http://localhost:${busy}` },
        },
      };
      const assignments = await allocateAssignments(config, state, ['game'], new Set());
      assert.notEqual(assignments.game!.port, busy);
      assert.equal(assignments.game!.transport, 'udp');
      const registry = await readRegistry();
      assert.equal(registry.ports[String(assignments.game!.port)]?.transport, 'udp');
    } finally {
      await close();
    }
  });

  it('keeps TCP assignments and registry entries as they were', async () => {
    const config = makeConfig('/project-tcp', [makeService({ port: 3000 })]);
    const assignments = await allocateAssignments(config, null, ['game'], new Set());
    assert.equal('transport' in assignments.game!, false);
    const registry = await readRegistry();
    assert.equal('transport' in registry.ports[String(assignments.game!.port)]!, false);
  });
});

// REVIEW: Protect pruning's transport default for old entries, and retention of
// active UDP reservations; allocation-only tests cannot catch premature pruning.
describe('registry pruning with UDP', () => {
  it('keeps old active UDP reservations, while legacy entries still mean TCP', async () => {
    const { port, close } = await occupyUdpPort();
    const entry = { project: '/project', service: 'game', port, assignedAt: new Date(0).toISOString() };
    const registry = { version: 1 as const, ports: { [String(port)]: { ...entry, transport: 'udp' as const } } };
    try {
      await pruneRegistry(registry);
      assert.ok(registry.ports[String(port)]);
      const legacy = { version: 1 as const, ports: { [String(port)]: entry } };
      await pruneRegistry(legacy);
      assert.deepEqual(legacy.ports, {});
    } finally {
      await close();
    }
    await pruneRegistry(registry);
    assert.deepEqual(registry.ports, {});
  });
});

// REVIEW: Test the public env path, not just the validator in isolation; env
// promises to check the same selection/dependency closure as up in a typed mode.
describe('env k8s with UDP', () => {
  it('refuses UDP-only dependencies before allocating any ports', async () => {
    const dir = await makeProject(
      'services:\n  game:\n    image: alpine:3.22\n    port: 19132\n    transport: udp\n  web:\n    image: alpine:3.22\n    depends_on: [game]\n',
    );
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    for (const selected of [[], ['game'], ['web']]) {
      const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'env', 'k8s', ...selected], {
        cwd: dir, env: process.env, encoding: 'utf8',
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /kubectl port-forward, which only carries TCP/);
      assert.equal(result.stdout, '');
    }
    assert.deepEqual((await readRegistry()).ports, {});
    await assert.rejects(fs.access(path.join(dir, '.portler', 'state.json')), { code: 'ENOENT' });
  });
});

describe('docker run with UDP', () => {
  const assignments: Assignments = {
    game: { name: 'game', port: 52001, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: 'http://localhost:52001' },
  };
  const docker = { image: 'game:1', containerName: 'game-container', volumes: [], env: {} };

  it('publishes /udp for udp, and both protocols for tcp+udp', () => {
    for (const [transport, expected] of [
      ['udp', '-p 127.0.0.1:52001:19132/udp game:1'],
      ['tcp+udp', '-p 127.0.0.1:52001:19132 -p 127.0.0.1:52001:19132/udp game:1'],
      [undefined, '-p 127.0.0.1:52001:19132 game:1'],
    ] as const) {
      const service = makeService({ port: 19132, docker, ...(transport ? { transport } : {}) });
      const command = dockerShellCommand(makeConfig('/project', [service]), service, {}, new Set(), assignments.game, assignments);
      assert.ok(command.endsWith(expected), `${transport}: ${command}`);
    }
  });
});

describe('Kubernetes with UDP', () => {
  const docker = { image: 'game:1', containerName: 'game-container', volumes: [], env: {} };

  function ports(transport: ServiceConfig['transport']) {
    const service = makeService({ port: 7777, docker, ...(transport ? { transport } : {}) });
    const manifests = serviceManifests(makeConfig('/project', [service]), service, 'game', []);
    const deployment = manifests.find((manifest) => manifest.kind === 'Deployment') as any;
    const k8sService = manifests.find((manifest) => manifest.kind === 'Service') as any;
    return { container: deployment.spec.template.spec.containers[0].ports, service: k8sService.spec.ports };
  }

  it('renders TCP services exactly as before', () => {
    assert.deepEqual(ports(undefined), {
      container: [{ containerPort: 7777 }],
      service: [{ port: 7777, targetPort: 7777 }],
    });
  });

  it('renders the protocol, and names the ports when there are two', () => {
    assert.deepEqual(ports('udp'), {
      container: [{ name: 'udp', containerPort: 7777, protocol: 'UDP' }],
      service: [{ name: 'udp', port: 7777, targetPort: 7777, protocol: 'UDP' }],
    });
    assert.deepEqual(ports('tcp+udp'), {
      container: [
        { name: 'tcp', containerPort: 7777, protocol: 'TCP' },
        { name: 'udp', containerPort: 7777, protocol: 'UDP' },
      ],
      service: [
        { name: 'tcp', port: 7777, targetPort: 7777, protocol: 'TCP' },
        { name: 'udp', port: 7777, targetPort: 7777, protocol: 'UDP' },
      ],
    });
  });

  it('up k8s refuses a UDP-only service, since port-forward only carries TCP', () => {
    const udp = makeService({ port: 19132, docker, transport: 'udp' });
    assert.throws(() => validateK8sForwards(makeConfig('/project', [udp]), ['game']), /kubectl port-forward, which only carries TCP/);
    const both = makeService({ port: 7777, docker, transport: 'tcp+udp' });
    assert.doesNotThrow(() => validateK8sForwards(makeConfig('/project', [both]), ['game']));
  });
});
