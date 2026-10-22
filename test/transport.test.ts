import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { validateK8sForwards } from '../src/cli/commands/up-k8s.ts';
import { loadConfig } from '../src/config/loader.ts';
import { serviceManifests } from '../src/k8s/manifests.ts';
import { allocateAssignments } from '../src/ports/allocate.ts';
import { isPortFree } from '../src/ports/probe.ts';
import { readRegistry } from '../src/ports/registry.ts';
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

function occupyUdpPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', reject);
    socket.bind(0, '127.0.0.1', () => {
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
