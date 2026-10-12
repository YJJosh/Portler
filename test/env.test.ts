import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGeneratedEnv } from '../src/env/generate.ts';
import { resolveEnvMap, resolveEnvValue } from '../src/env/resolve.ts';
import { assertRequiredEnv, buildEffectiveEnv, buildPrintableEnv, buildServiceEnv, maskSecrets, requiredEnvKeys } from '../src/env/service.ts';
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

  it('keeps generated values above service env in development too, and in the printable env', () => {
    const service = makeService({ env: { PORTLER_API_PORT: '1', PORTLER_API_URL: 'stale' } });
    const config = makeConfig({ api: service });
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);

    const { env } = buildServiceEnv(config, service, {}, generated, assignments);
    assert.equal(env.PORTLER_API_PORT, '52001');
    assert.equal(env.PORTLER_API_URL, 'http://localhost:52001');
    const printable = buildPrintableEnv(config, service, generated, assignments);
    assert.equal(printable.PORTLER_API_PORT, '52001');
  });

  it('resolves service references in root and service env', () => {
    const service = makeService({ env: { API_URL: 'api.url', DB: 'localhost:${db-main.port}' } });
    const config = makeConfig({ api: service });
    const assignments = makeAssignments();

    const { env } = buildServiceEnv(config, service, {}, {}, assignments);
    assert.equal(env.API_URL, 'http://localhost:52001');
    assert.equal(env.DB, 'localhost:52002');
  });

  it('lets the deployment win over portler.yml in production, except for generated values', () => {
    const service = makeService({ env: { FROM_SERVICE: 'service', SHARED: 'service', SHELL_WINS: 'service' } });
    const config = makeConfig({ api: service }, { FROM_ROOT: 'root', SHARED: 'root' });
    const baseEnv = { SHARED: 'file', SHELL_WINS: 'file', FROM_FILE: 'file' };
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    const saved = { SHELL_WINS: process.env.SHELL_WINS, PORTLER_API_PORT: process.env.PORTLER_API_PORT, PORT: process.env.PORT };
    process.env.SHELL_WINS = 'shell';
    process.env.PORTLER_API_PORT = 'shell';
    process.env.PORT = '1';
    try {
      const dev = buildServiceEnv(config, service, baseEnv, generated, assignments);
      assert.equal(dev.env.SHARED, 'service', 'development: config wins');
      assert.equal(dev.env.SHELL_WINS, 'service');

      const prod = buildServiceEnv({ ...config, production: true }, service, baseEnv, generated, assignments);
      assert.equal(prod.env.SHELL_WINS, 'shell', 'production: the process env wins over file and config');
      assert.equal(prod.env.SHARED, 'file', 'production: the use_env file wins over config');
      assert.equal(prod.env.FROM_ROOT, 'root');
      assert.equal(prod.env.FROM_SERVICE, 'service');
      assert.equal(prod.env.FROM_FILE, 'file');
      assert.equal(prod.env.PORTLER_API_PORT, '52001', 'generated values stay Portler\'s');
      assert.equal(prod.env.PORT, '52001', 'port_env stays Portler\'s');
      assert.equal(prod.env.PORTLER_SERVICE_NAME, 'api');
      // Containers get the named keys in both modes; the env files' keys only in development.
      assert.ok(dev.explicitKeys.has('FROM_FILE'), 'development forwards the env files');
      assert.deepEqual([...prod.explicitKeys].sort(), [...dev.explicitKeys].filter((key) => key !== 'FROM_FILE').sort(), 'production forwards only named keys');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('does not resolve config values the deployment overrides in production', () => {
    const service = makeService({ env: { DB_URL: 'missing.url', KEEP: 'api.url' } });
    const config = makeConfig({ api: service }, { ROOT_URL: 'missing.url' });
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    // Development: config wins, so the dangling reference is a config error even with a file value.
    assert.throws(() => buildServiceEnv(config, service, { DB_URL: 'file', ROOT_URL: 'file' }, generated, assignments), /cannot resolve|no assigned port/);
    const prod = { ...config, production: true };
    // Production without anything overriding it: still a config error.
    assert.throws(() => buildServiceEnv(prod, service, {}, generated, assignments), /cannot resolve|no assigned port/);
    const saved = process.env.ROOT_URL;
    process.env.ROOT_URL = 'shell';
    try {
      const { env, explicitKeys } = buildServiceEnv(prod, service, { DB_URL: 'file' }, generated, assignments);
      assert.equal(env.DB_URL, 'file', 'the use_env file replaces the unresolvable config value');
      assert.equal(env.ROOT_URL, 'shell', 'the process env replaces the unresolvable config value');
      assert.equal(env.KEEP, 'http://localhost:52001', 'other config values still resolve');
      assert.equal(explicitKeys.has('DB_URL') && explicitKeys.has('ROOT_URL'), true, 'overridden keys still reach containers');
    } finally {
      if (saved === undefined) delete process.env.ROOT_URL;
      else process.env.ROOT_URL = saved;
    }
  });

  it('does not resolve a root value the service replaces, in either mode', () => {
    // Root URL is a dangling reference; api's own env (what prod.env becomes after
    // applyProduction) replaces URL, so the root value is never used for api and must not
    // throw. A service that does not replace it still hits the config error.
    const service = makeService({ env: { URL: 'https://api.example' } });
    const config = makeConfig({ api: service }, { URL: 'missing.url', OTHER: 'api.url' });
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    const dev = buildServiceEnv(config, service, {}, generated, assignments);
    assert.equal(dev.env.URL, 'https://api.example');
    assert.equal(dev.env.OTHER, 'http://localhost:52001', 'other root values still resolve');
    const prod = { ...config, production: true };
    assert.equal(buildServiceEnv(prod, service, {}, generated, assignments).env.URL, 'https://api.example');
    assert.equal(buildPrintableEnv(config, service, generated, assignments).URL, 'https://api.example', 'portler env agrees with up');
    assert.throws(() => buildServiceEnv(config, makeService({}), {}, generated, assignments), /cannot resolve|no assigned port/);
  });

  it('forwards only named keys to containers in production, including prod.require', () => {
    const service = makeService({ env: { NAMED: '' }, prod: { env: {}, require: ['TOKEN'] } });
    const base = { NAMED: 'from-file', TOKEN: 'from-file', FILE_ONLY: 'from-file' };
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    const dev = buildServiceEnv(makeConfig({ api: service }), service, base, generated, assignments);
    assert.ok(dev.explicitKeys.has('FILE_ONLY'), 'development forwards the env files');
    const prod = buildServiceEnv({ ...makeConfig({ api: service }), production: true }, service, base, generated, assignments);
    assert.equal(prod.env.NAMED, 'from-file');
    assert.equal(prod.env.TOKEN, 'from-file');
    assert.ok(prod.explicitKeys.has('NAMED') && prod.explicitKeys.has('TOKEN'));
    assert.ok(!prod.explicitKeys.has('FILE_ONLY'), 'a key only the file has is not forwarded in production');
    assert.equal(prod.env.FILE_ONLY, 'from-file', 'it is still in the local process env');
  });

  it('takes a required key from the deployment only, and reports the missing ones', () => {
    // A required key with a config value: the value is not used (nor resolved), the
    // deployment supplies it, and the check names what is missing.
    const service = makeService({ env: { DB: 'missing.url' }, prod: { env: {}, require: ['DB', 'DEPLOY_SECRET'] } });
    const config = { ...makeConfig({ api: service }), production: true };
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    assert.deepEqual(requiredEnvKeys(config, service), ['DB', 'DEPLOY_SECRET']);
    const without = buildServiceEnv(config, service, {}, generated, assignments);
    assert.equal(without.env.DB, undefined, 'the config value of a required key is not used');
    assert.throws(() => assertRequiredEnv('service api', requiredEnvKeys(config, service), without.env), /service api requires DB, DEPLOY_SECRET in production/);
    const withFile = buildServiceEnv(config, service, { DB: 'postgres://x', DEPLOY_SECRET: '' }, generated, assignments);
    assert.throws(() => assertRequiredEnv('service api', requiredEnvKeys(config, service), withFile.env), /requires DEPLOY_SECRET in production/);
    assert.doesNotThrow(() => assertRequiredEnv('service api', requiredEnvKeys(config, service), { ...withFile.env, DEPLOY_SECRET: 's' }));
  });

  it('counts a blank prod.env entry as required, like prod.require', () => {
    // `prod.env: {KEY: ''}` (or a bare `KEY:`) says the deployment supplies the key, so a
    // deployment that omits it fails the check instead of starting with an empty value.
    const service = makeService({ env: { DATABASE_URL: 'postgres://dev' }, prod: { env: { DATABASE_URL: '', TOKEN: null, NODE_ENV: 'production' }, require: [] } });
    const config = { ...makeConfig({ api: service }), production: true };
    assert.deepEqual(requiredEnvKeys(config, service).sort(), ['DATABASE_URL', 'TOKEN']);
    assert.throws(() => assertRequiredEnv('service api', requiredEnvKeys(config, service), { NODE_ENV: 'production' }), /service api requires DATABASE_URL, TOKEN in production/);
    assert.doesNotThrow(() => assertRequiredEnv('service api', requiredEnvKeys(config, service), { DATABASE_URL: 'postgres://prod', TOKEN: 't' }));
    // A blank top-level entry is required of the project and of a service with no value of
    // its own for the key, not of one whose own env replaces it.
    const plain = makeService({ name: 'plain' });
    const own = makeService({ name: 'own', env: { PUBLIC_URL: 'https://own.example' } });
    const root = { ...makeConfig({ plain, own }), production: true, prod: { env: { PUBLIC_URL: '' }, require: [] } };
    assert.deepEqual(requiredEnvKeys(root), ['PUBLIC_URL']);
    assert.deepEqual(requiredEnvKeys(root, plain), ['PUBLIC_URL']);
    assert.deepEqual(requiredEnvKeys(root, own), []);
  });

  it('masks generic key-like names too, not only the usual suspects', () => {
    const masked = maskSecrets({ SIGNING_KEY: 'a', ENCRYPTION_KEY: 'b', SSH_KEY: 'c', KEY: 'd', PASSPHRASE: 'e', TLS_CERT: 'f', KEYCLOAK_URL: 'http://kc', PUBLIC_PORT: '80' });
    assert.deepEqual(masked, { SIGNING_KEY: '***', ENCRYPTION_KEY: '***', SSH_KEY: '***', KEY: '***', PASSPHRASE: '***', TLS_CERT: '***', KEYCLOAK_URL: 'http://kc', PUBLIC_PORT: '80' });
  });

  it('masks the password of a URL whose user is empty, and leaves URLs without credentials alone', () => {
    const masked = maskSecrets({
      REDIS_URL: 'redis://:hunter2@cache:6379/0',
      DATABASE_URL: 'postgres://app:hunter2@db:5432/app',
      PLAIN_URL: 'http://cache:6379/path@v2',
      USER_ONLY: 'http://me@cache',
    });
    assert.deepEqual(masked, {
      REDIS_URL: 'redis://:***@cache:6379/0',
      DATABASE_URL: 'postgres://app:***@db:5432/app',
      PLAIN_URL: 'http://cache:6379/path@v2',
      USER_ONLY: 'http://me@cache',
    });
  });

  it('prints the deployment view with secrets masked', () => {
    const service = makeService({ env: { DATABASE_URL: 'postgres://app:hunter2@db:5432/app', API_TOKEN: 'abc', PLAIN: 'x' } });
    const config = { ...makeConfig({ api: service }, { ROOT_VALUE: 'r' }), production: true };
    const assignments = makeAssignments();
    const generated = buildGeneratedEnv(assignments);
    const effective = buildEffectiveEnv(config, service, { FILE_ONLY: 'f', PLAIN: 'from-file' }, generated, assignments);
    assert.equal(effective.PLAIN, 'from-file', 'the deployment value');
    assert.equal(effective.ROOT_VALUE, 'r');
    assert.equal(effective.FILE_ONLY, undefined, 'only forwarded keys are shown');
    assert.equal(effective.PORTLER_SERVICE_NAME, 'api');
    assert.equal(effective.pnpm_config_verify_deps_before_run, undefined, 'Portler-internal keys are not shown');
    const masked = maskSecrets(effective);
    assert.equal(masked.API_TOKEN, '***');
    assert.equal(masked.DATABASE_URL, 'postgres://app:***@db:5432/app');
    assert.equal(masked.PLAIN, 'from-file');
    assert.equal(maskSecrets(effective, true).API_TOKEN, 'abc');
    const root = buildEffectiveEnv(config, null, { FILE_ONLY: 'f' }, generated, assignments);
    assert.equal(root.ROOT_VALUE, 'r');
    assert.equal(root.FILE_ONLY, undefined);
    assert.ok(root.PORTLER_API_PORT);
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
