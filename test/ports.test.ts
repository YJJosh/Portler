import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { allocateAssignments, releasePorts } from '../src/ports/allocate.ts';
import { globalPortlerDir, registryPath } from '../src/ports/locations.ts';
import { pruneRegistry, readRegistry, writeRegistry } from '../src/ports/registry.ts';
import type { PortlerConfig, RegistryFile, ServiceConfig, StateFile } from '../src/types/index.ts';

const NO_RUNNING = new Set<string>();

let previousGlobalDir: string | undefined;
let tempGlobalDir: string;

beforeEach(async () => {
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
  tempGlobalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-registry-'));
  process.env.PORTLER_GLOBAL_DIR = tempGlobalDir;
});

afterEach(async () => {
  if (previousGlobalDir === undefined) {
    delete process.env.PORTLER_GLOBAL_DIR;
  } else {
    process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
  }
  await fs.rm(tempGlobalDir, { recursive: true, force: true });
});

function makeService(name: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    cwd: '.',
    port: 4000,
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
    portRange: { start: 52300, end: 52999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: projectDir,
    volumes: [],
    k8sNamespace: 'portler-test',
    services: Object.fromEntries(services.map((service) => [service.name, service])),
  };
}

function makeState(projectDir: string, ports: Record<string, number>): StateFile {
  return {
    version: 1,
    project: projectDir,
    updatedAt: new Date().toISOString(),
    services: Object.fromEntries(
      Object.entries(ports).map(([name, port]) => [
        name,
        {
          name,
          port,
          host: '127.0.0.1',
          urlHost: 'localhost',
          protocol: 'http',
          url: `http://localhost:${port}`,
        },
      ]),
    ),
  };
}

function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function findFreePort(): Promise<number> {
  const { port, close } = await occupyPort();
  await close();
  return port;
}

describe('globalPortlerDir override', () => {
  it('respects PORTLER_GLOBAL_DIR', () => {
    assert.equal(globalPortlerDir(), path.resolve(tempGlobalDir));
    assert.equal(registryPath(), path.join(path.resolve(tempGlobalDir), 'ports.json'));
  });
});

describe('allocateAssignments', () => {
  it('assigns ports in range and records reservations for reserved services', async () => {
    const config = makeConfig('/project-a', [makeService('api', { port: 4000 }), makeService('web', { port: 3000 })]);
    const assignments = await allocateAssignments(config, null, ['api', 'web'], NO_RUNNING);

    for (const name of ['api', 'web']) {
      const assignment = assignments[name]!;
      assert.ok(assignment.port >= 52300 && assignment.port <= 52999, `port ${assignment.port} out of range`);
      assert.equal(assignment.url, `http://localhost:${assignment.port}`);
    }
    assert.equal(assignments.api!.desiredPort, 4000);
    assert.notEqual(assignments.api!.port, assignments.web!.port);

    const registry = await readRegistry();
    const entries = Object.values(registry.ports);
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.service)), new Set(['api', 'web']));
    assert.ok(entries.every((entry) => entry.project === '/project-a'));
  });

  it('skips services without a declared port', async () => {
    const config = makeConfig('/project-a', [makeService('worker', { port: undefined })]);
    const assignments = await allocateAssignments(config, null, ['worker'], NO_RUNNING);
    assert.deepEqual(assignments, {});
  });

  it('reuses the previous state port when it is still free', async () => {
    const statePort = await findFreePort();
    const config = makeConfig('/project-a', [makeService('api')]);
    const state = makeState('/project-a', { api: statePort });

    const assignments = await allocateAssignments(config, state, ['api'], NO_RUNNING);
    assert.equal(assignments.api!.port, statePort);
  });

  it('moves to a new port when the previous state port is occupied', async () => {
    const { port: busyPort, close } = await occupyPort();
    try {
      const config = makeConfig('/project-a', [makeService('api')]);
      const state = makeState('/project-a', { api: busyPort });

      const assignments = await allocateAssignments(config, state, ['api'], NO_RUNNING);
      assert.notEqual(assignments.api!.port, busyPort);
      assert.ok(assignments.api!.port >= 52300 && assignments.api!.port <= 52999);
    } finally {
      await close();
    }
  });

  it('avoids ports reserved by other projects even when they are free', async () => {
    const reservedPort = await findFreePort();
    const registry: RegistryFile = {
      version: 1,
      ports: {
        [String(reservedPort)]: {
          project: '/other-project',
          service: 'their-api',
          port: reservedPort,
          assignedAt: new Date().toISOString(),
        },
      },
    };
    await writeRegistry(registry);

    const config = makeConfig('/project-a', [makeService('api')]);
    const state = makeState('/project-a', { api: reservedPort });

    const assignments = await allocateAssignments(config, state, ['api'], NO_RUNNING);
    assert.notEqual(assignments.api!.port, reservedPort);

    const after = await readRegistry();
    assert.equal(after.ports[String(reservedPort)]?.project, '/other-project');
  });

  it('reclaims the service\'s own registry reservation first', async () => {
    const ownPort = await findFreePort();
    await writeRegistry({
      version: 1,
      ports: {
        [String(ownPort)]: {
          project: '/project-a',
          service: 'api',
          port: ownPort,
          assignedAt: new Date().toISOString(),
        },
      },
    });

    const config = makeConfig('/project-a', [makeService('api')]);
    const assignments = await allocateAssignments(config, null, ['api'], NO_RUNNING);
    assert.equal(assignments.api!.port, ownPort);
  });

  it('reuses ports of running services verbatim without probing', async () => {
    const { port: busyPort, close } = await occupyPort();
    try {
      await writeRegistry({
        version: 1,
        ports: {
          [String(busyPort)]: {
            project: '/project-a',
            service: 'api',
            port: busyPort,
            assignedAt: new Date().toISOString(),
          },
        },
      });

      const config = makeConfig('/project-a', [makeService('api'), makeService('web', { port: 3000 })]);
      const assignments = await allocateAssignments(config, null, ['web'], new Set(['api']));

      // api is running on its registered (busy) port and must keep it.
      assert.equal(assignments.api!.port, busyPort);
      assert.notEqual(assignments.web!.port, busyPort);
    } finally {
      await close();
    }
  });

  it('prefers the declared port when prefer_declared_port is set', async () => {
    const declaredPort = await findFreePort();
    const config = makeConfig('/project-a', [
      makeService('api', { port: declaredPort, preferDeclaredPort: true }),
    ]);

    const assignments = await allocateAssignments(config, null, ['api'], NO_RUNNING);
    assert.equal(assignments.api!.port, declaredPort);
  });

  it('assigns stable ports across consecutive allocations (state reuse)', async () => {
    const config = makeConfig('/project-a', [makeService('api'), makeService('web', { port: 3000 })]);
    const first = await allocateAssignments(config, null, ['api', 'web'], NO_RUNNING);

    const state = makeState('/project-a', {
      api: first.api!.port,
      web: first.web!.port,
    });
    const second = await allocateAssignments(config, state, ['api', 'web'], NO_RUNNING);

    assert.equal(second.api!.port, first.api!.port);
    assert.equal(second.web!.port, first.web!.port);
  });
});

describe('releasePorts', () => {
  it('removes only the given project\'s (and optionally services\') entries', async () => {
    const entry = (project: string, service: string, port: number) => ({
      project,
      service,
      port,
      assignedAt: new Date().toISOString(),
    });
    await writeRegistry({
      version: 1,
      ports: {
        '52310': entry('/project-a', 'api', 52310),
        '52311': entry('/project-a', 'web', 52311),
        '52312': entry('/other', 'api', 52312),
      },
    });

    await releasePorts('/project-a', ['api']);
    let registry = await readRegistry();
    assert.deepEqual(Object.keys(registry.ports).sort(), ['52311', '52312']);

    await releasePorts('/project-a');
    registry = await readRegistry();
    assert.deepEqual(Object.keys(registry.ports), ['52312']);
  });
});

describe('pruneRegistry', () => {
  it('drops stale entries with free ports, keeps busy and fresh ones', async () => {
    const { port: busyPort, close } = await occupyPort();
    try {
      const freePort = await findFreePort();
      const staleTime = new Date(Date.now() - 10 * 60_000).toISOString();
      const registry: RegistryFile = {
        version: 1,
        ports: {
          [String(freePort)]: { project: '/a', service: 'stale-free', port: freePort, assignedAt: staleTime },
          [String(busyPort)]: { project: '/a', service: 'stale-busy', port: busyPort, assignedAt: staleTime },
          '52350': { project: '/a', service: 'fresh', port: 52350, assignedAt: new Date().toISOString() },
        },
      };

      await pruneRegistry(registry);

      assert.equal(registry.ports[String(freePort)], undefined);
      assert.equal(registry.ports[String(busyPort)]?.service, 'stale-busy');
      assert.equal(registry.ports['52350']?.service, 'fresh');
    } finally {
      await close();
    }
  });

  it('probes the recorded bind host instead of assuming every reservation is on IPv4 loopback', async () => {
    const port = await findFreePort();
    const registry: RegistryFile = {
      version: 1,
      ports: {
        [String(port)]: {
          project: '/a',
          service: 'custom-host',
          port,
          host: 'host-that-does-not-exist.invalid',
          assignedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        },
      },
    };

    await pruneRegistry(registry);
    assert.ok(registry.ports[String(port)], 'a failed bind on the recorded host is not proof that the reservation is stale');
  });
});

describe('readRegistry', () => {
  it('returns an empty registry when the file does not exist', async () => {
    assert.deepEqual(await readRegistry(), { version: 1, ports: {} });
  });

  it('rejects corrupt registry files', async () => {
    await fs.mkdir(globalPortlerDir(), { recursive: true });
    await fs.writeFile(registryPath(), JSON.stringify({ version: 99 }), 'utf8');
    await assert.rejects(readRegistry(), /invalid global Portler port registry/);
    await assert.rejects(readRegistry(), /portler clean --global --force/);
  });
});

describe('own-port reclaim respects in-flight reservations', () => {
  it('does not hand one port to two services of the same project', async () => {
    // The regression. Both services are being (re)started, so their registry
    // entries are dropped up front to let each reclaim its previous port:
    //
    //   - "web" has a stale registry reservation on port P.
    //   - "api"'s previous port (from state.json) is also P.
    //
    // Nothing is listening on P (both services are stopped), so P probes as
    // free. "api" is allocated first and takes P. Then "web"'s own-port reclaim
    // returned P as well — it only checked isPortFree and ignored reservedPorts,
    // which by then already contained the port just handed to "api". Both
    // services then raced to bind the same port.
    const port = await findFreePort();
    const projectDir = '/project-reclaim';

    await writeRegistry({
      version: 1,
      ports: {
        [String(port)]: {
          project: projectDir,
          service: 'web',
          port,
          assignedAt: new Date().toISOString(),
        },
      },
    });

    const config = makeConfig(projectDir, [makeService('api', { port: 4000 }), makeService('web', { port: 3000 })]);
    const state = makeState(projectDir, { api: port });

    const assignments = await allocateAssignments(config, state, ['api', 'web'], NO_RUNNING);

    assert.notEqual(
      assignments.api!.port,
      assignments.web!.port,
      `both services were assigned port ${assignments.api!.port}`,
    );
    // One of them still legitimately reclaims the free port.
    assert.ok([assignments.api!.port, assignments.web!.port].includes(port));

    // And the registry must not collapse the two reservations onto one key.
    const registry = await readRegistry();
    const owned = Object.values(registry.ports).filter((entry) => entry.project === projectDir);
    assert.equal(owned.length, 2);
    assert.deepEqual(owned.map((entry) => entry.service).sort(), ['api', 'web']);
  });
});
