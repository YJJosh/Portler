import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGeneratedEnv } from '../src/env/generate.ts';
import { resolveEnvMap, resolveEnvValue } from '../src/env/resolve.ts';
import { buildServiceEnv } from '../src/env/service.ts';
import type { Assignments, PortlerConfig, ServiceConfig } from '../src/types/index.ts';

function makeAssignments(): Assignments {
  return {
    api: {
      name: 'api',
      port: 52001,
      desiredPort: 4000,
      host: '127.0.0.1',
      urlHost: 'localhost',
      protocol: 'http',
      url: 'http://localhost:52001',
    },
    'db-main': {
      name: 'db-main',
      port: 52002,
      host: '127.0.0.1',
      urlHost: 'localhost',
      protocol: 'http',
      url: 'http://localhost:52002',
      containerName: 'portler-proj-abc-db-main',
      image: 'postgres:16-alpine',
    },
  };
}

describe('resolveEnvValue', () => {
  const assignments = makeAssignments();

  it('resolves whole-value service references', () => {
    assert.equal(resolveEnvValue('api.url', assignments), 'http://localhost:52001');
    assert.equal(resolveEnvValue('api.port', assignments), '52001');
    assert.equal(resolveEnvValue('api.host', assignments), '127.0.0.1');
    assert.equal(resolveEnvValue('api.url_host', assignments), 'localhost');
    assert.equal(resolveEnvValue('api.urlHost', assignments), 'localhost');
    assert.equal(resolveEnvValue('api.protocol', assignments), 'http');
    assert.equal(resolveEnvValue('api.name', assignments), 'api');
    assert.equal(resolveEnvValue('api.desired_port', assignments), '4000');
  });

  it('resolves Docker metadata references', () => {
    assert.equal(resolveEnvValue('db-main.container', assignments), 'portler-proj-abc-db-main');
    assert.equal(resolveEnvValue('db-main.container_name', assignments), 'portler-proj-abc-db-main');
    assert.equal(resolveEnvValue('db-main.image', assignments), 'postgres:16-alpine');
  });

  it('returns empty strings for optional properties that are unset', () => {
    assert.equal(resolveEnvValue('db-main.desired_port', assignments), '');
    assert.equal(resolveEnvValue('api.container', assignments), '');
    assert.equal(resolveEnvValue('api.image', assignments), '');
  });

  it('resolves ${service.property} interpolations inside strings', () => {
    assert.equal(
      resolveEnvValue('postgres://app:app@localhost:${db-main.port}/app', assignments),
      'postgres://app:app@localhost:52002/app',
    );
  });

  it('resolves multiple interpolations in one value', () => {
    assert.equal(resolveEnvValue('${api.url} and ${db-main.port}', assignments), 'http://localhost:52001 and 52002');
  });

  it('keeps bare dotted literals that look like hostnames or files', () => {
    assert.equal(resolveEnvValue('example.com', assignments), 'example.com');
    assert.equal(resolveEnvValue('file.txt', assignments), 'file.txt');
  });

  it('keeps values with more than one dot literal', () => {
    assert.equal(resolveEnvValue('api.example.com', assignments), 'api.example.com');
  });

  it('rejects unknown properties on known services (typo detection)', () => {
    assert.throws(() => resolveEnvValue('api.prot', assignments), /unknown property "prot" in service reference/);
  });

  it('rejects known properties on services without assignments (typo detection)', () => {
    assert.throws(() => resolveEnvValue('backnd.port', assignments), /service "backnd" has no assigned port/);
  });

  it('rejects unresolvable ${...} interpolations', () => {
    assert.throws(() => resolveEnvValue('x-${missing.port}-y', assignments), /service "missing" has no assigned port/);
    assert.throws(() => resolveEnvValue('x-${api.bogus}-y', assignments), /unknown property "bogus" in service reference/);
  });

  it('stringifies numbers, booleans, and null-ish values', () => {
    assert.equal(resolveEnvValue(4000, assignments), '4000');
    assert.equal(resolveEnvValue(true, assignments), 'true');
    assert.equal(resolveEnvValue(false, assignments), 'false');
    assert.equal(resolveEnvValue(null, assignments), '');
    assert.equal(resolveEnvValue(undefined, assignments), '');
  });
});

describe('resolveEnvMap', () => {
  it('resolves every value and validates keys', () => {
    const assignments = makeAssignments();
    assert.deepEqual(resolveEnvMap({ URL: 'api.url', PORT: 4000 }, assignments), {
      URL: 'http://localhost:52001',
      PORT: '4000',
    });
    assert.throws(() => resolveEnvMap({ 'BAD-KEY': 'x' }, assignments), /invalid env key "BAD-KEY"/);
  });
});

describe('buildGeneratedEnv', () => {
  it('exposes PORTLER_* values for every assignment', () => {
    const env = buildGeneratedEnv(makeAssignments());

    assert.equal(env.PORTLER_SERVICE_NAMES, 'api,db-main');
    assert.equal(env.PORTLER_API_PORT, '52001');
    assert.equal(env.PORTLER_API_URL, 'http://localhost:52001');
    assert.equal(env.PORTLER_API_HOST, '127.0.0.1');
    assert.equal(env.PORTLER_API_URL_HOST, 'localhost');
    assert.equal(env.PORTLER_API_PROTOCOL, 'http');
    assert.equal(env.PORTLER_API_DESIRED_PORT, '4000');
    // Dashed service names become upper snake case.
    assert.equal(env.PORTLER_DB_MAIN_PORT, '52002');
    assert.equal(env.PORTLER_DB_MAIN_CONTAINER, 'portler-proj-abc-db-main');
    assert.equal(env.PORTLER_DB_MAIN_IMAGE, 'postgres:16-alpine');
  });

  it('omits optional keys when the assignment lacks them', () => {
    const env = buildGeneratedEnv(makeAssignments());
    assert.equal('PORTLER_API_CONTAINER' in env, false);
    assert.equal('PORTLER_API_IMAGE' in env, false);
    assert.equal('PORTLER_DB_MAIN_DESIRED_PORT' in env, false);
  });
});

function makeConfig(services: Record<string, ServiceConfig>, env: Record<string, unknown> = {}): PortlerConfig {
  return {
    filePath: '/project/portler.yml',
    projectDir: '/project',
    useEnv: [],
    env,
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: '/project',
    volumes: [],
    k8sNamespace: 'portler-test',
    services,
  };
}

function makeService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'api',
    command: 'npm run dev',
    cwd: '.',
    port: 4000,
    portEnv: ['PORT'],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    preferDeclaredPort: false,
    dependsOn: [],
    ...overrides,
  };
}

describe('buildServiceEnv', () => {
  it('layers base, root, generated, and service env with increasing precedence', () => {
    const service = makeService({ env: { FROM_SERVICE: 'service', SHARED: 'service-wins' } });
    const config = makeConfig({ api: service }, { FROM_ROOT: 'root', SHARED: 'root' });
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);

    const { env, explicitKeys } = buildServiceEnv(config, service, { FROM_BASE: 'base', SHARED: 'base' }, generated, assignments);

    assert.equal(env.FROM_BASE, 'base');
    assert.equal(env.FROM_ROOT, 'root');
    assert.equal(env.FROM_SERVICE, 'service');
    assert.equal(env.SHARED, 'service-wins');
    assert.equal(env.PORTLER_SERVICE_NAME, 'api');
    assert.equal(env.PORTLER_API_URL, 'http://localhost:52001');
    // port_env keys get the assigned host port for local services.
    assert.equal(env.PORT, '52001');

    for (const key of ['FROM_BASE', 'FROM_ROOT', 'FROM_SERVICE', 'SHARED', 'PORT', 'PORTLER_SERVICE_NAME']) {
      assert.equal(explicitKeys.has(key), true, `expected explicit key ${key}`);
    }
    assert.equal(explicitKeys.has('PATH'), false);
  });

  it('resolves service references in root and service env', () => {
    const service = makeService({ env: { API_URL: 'api.url', DB: 'localhost:${db-main.port}' } });
    const config = makeConfig({ api: service });
    const assignments = makeAssignments();

    const { env } = buildServiceEnv(config, service, {}, {}, assignments);
    assert.equal(env.API_URL, 'http://localhost:52001');
    assert.equal(env.DB, 'localhost:52002');
  });

  it('gives Docker services their declared internal port in port_env', () => {
    const service = makeService({
      port: 5432,
      portEnv: ['PGPORT'],
      docker: { image: 'postgres:16', containerName: 'c', volumes: [], env: {} },
    });
    const config = makeConfig({ api: service });
    const assignments = makeAssignments();

    const { env } = buildServiceEnv(config, service, {}, {}, assignments);
    // The -p mapping translates the host port, so the container sees 5432.
    assert.equal(env.PGPORT, '5432');
  });
});
