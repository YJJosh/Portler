import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { applyDockerMode } from '../src/config/docker.ts';
import { EnvSpec, mergeEnvEntry } from '../src/config/env-spec.ts';
import { applyK8sMode } from '../src/config/k8s.ts';
import { loadConfig } from '../src/config/loader.ts';
import { applyProduction } from '../src/config/production.ts';
import { renderManifests } from '../src/k8s/render.ts';
import { buildGeneratedEnv } from '../src/env/generate.ts';
import { resolveEnvValue } from '../src/env/resolve.ts';
import {
  assertEnvRequirements,
  buildEffectiveEnv,
  buildPrintableEnv,
  buildServiceEnv,
  envRequirementProblems,
  maskSecrets,
  requiredEnvKeys,
} from '../src/env/service.ts';
import type { Assignments, PortlerConfig } from '../src/types/index.ts';

const dirs: string[] = [];
async function config(text: string): Promise<PortlerConfig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-env-spec-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'portler.yml'), text);
  return loadConfig(dir);
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Assignments as `up` would make them, with fixed ports. */
function assign(cfg: PortlerConfig, ports: Record<string, number>): Assignments {
  const assignments: Assignments = {};
  for (const [name, port] of Object.entries(ports)) {
    const service = cfg.services[name]!;
    assignments[name] = {
      name,
      port,
      ...(service.port === undefined ? {} : { desiredPort: service.port }),
      host: '127.0.0.1',
      urlHost: 'localhost',
      protocol: 'http',
      url: `http://localhost:${port}`,
      ...(service.docker ? { containerName: service.docker.containerName, image: service.docker.image } : {}),
    };
  }
  return assignments;
}

/** Run `body` with these process env values set, restoring the old ones after. */
function withProcessEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (next: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  try {
    return body();
  } finally {
    apply(old);
  }
}

const STACK = `env:
  LOG_LEVEL: { default: info }
  STRIPE_KEY: { required: true, description: Test key from the Stripe dashboard }
services:
  db:
    image: postgres:18-alpine
    port: 5432
    env:
      POSTGRES_USER: { default: app }
      POSTGRES_PASSWORD: { default: devpass, secret: true }
    exports:
      database_url: postgres://\${env.POSTGRES_USER}:\${env.POSTGRES_PASSWORD}@\${self.address}/app
  api:
    command: node server.js
    port: 4000
    depends_on: [db]
    env:
      DATABASE_URL: \${db.database_url}
      DB_ADDRESS: db.address
      DB_HOST: \${db.address_host}
      DB_PORT: \${db.address_port}
      SELF: \${self.address}
      SECRET: { value: dev-secret, secret: true, required: prod }
    docker:
      image: node:22
`;

describe('env entries with metadata', () => {
  it('normalizes mappings into specs and rejects bad ones by name', async () => {
    const cfg = await config(STACK);
    assert.ok(cfg.env.LOG_LEVEL instanceof EnvSpec);
    assert.deepEqual({ ...(cfg.services.api!.env.SECRET as EnvSpec) }, { value: 'dev-secret', secret: true, required: 'prod' });
    for (const [text, error] of [
      ['services: {api: {command: x, env: {A: {value: 1, default: 2}}}}', /services\.api\.env\.A cannot set both value and default/],
      ['services: {api: {command: x, env: {A: {required: yes}}}}', /services\.api\.env\.A\.required must be true, false or "prod"/],
      ['services: {api: {command: x, env: {A: {secrect: true}}}}', /unknown key "services\.api\.env\.A\.secrect"/],
      ['env: {A: {default: [1]}}\nservices: {api: {command: x}}', /env\.A\.default must be a string, number or boolean/],
      ['services: {api: {command: x, prod: {env: {A: {description: 4}}}}}', /services\.api\.prod\.env\.A\.description must be a string/],
    ] as const) {
      await assert.rejects(config(text), error);
    }
  });

  it('lets the shell and use_env files override a default, but not a plain value', async () => {
    const cfg = await config(`env:
  LEVEL: { default: info }
  FIXED: pinned
services:
  api: { command: x, env: { ONLY_DEFAULT: { default: d } } }
`);
    const api = cfg.services.api!;
    const plain = buildServiceEnv(cfg, api, {}, {}, {});
    assert.equal(plain.env.LEVEL, 'info');
    assert.equal(plain.env.ONLY_DEFAULT, 'd');
    const overridden = withProcessEnv({ LEVEL: 'debug', FIXED: 'shell' }, () => buildServiceEnv(cfg, api, { ONLY_DEFAULT: 'file' }, {}, {}));
    assert.equal(overridden.env.LEVEL, 'debug', 'the shell wins over a default');
    assert.equal(overridden.env.ONLY_DEFAULT, 'file', 'a use_env file wins over a default');
    assert.equal(overridden.env.FIXED, 'pinned', 'a plain config value still wins in development');
    // In production the deployment wins over both.
    const prod = applyProduction(cfg, true);
    const deployed = withProcessEnv({ FIXED: 'platform' }, () => buildServiceEnv(prod, prod.services.api!, {}, {}, {}));
    assert.equal(deployed.env.FIXED, 'platform');
    assert.equal(deployed.env.LEVEL, 'info');
  });

  it('keeps an entry with no value out of the env, so only the shell or a file sets it', async () => {
    const cfg = await config(`services:\n  api: { command: x, env: { TOKEN: { required: true } } }\n`);
    const api = cfg.services.api!;
    assert.equal(Object.hasOwn(buildServiceEnv(cfg, api, {}, {}, {}).env, 'TOKEN'), false);
    const supplied = buildServiceEnv(cfg, api, { TOKEN: 't' }, {}, {});
    assert.equal(supplied.env.TOKEN, 't');
    assert.ok(supplied.explicitKeys.has('TOKEN'), 'containers get the key the config names');
  });

  it('keeps metadata when a higher layer only sets the value', async () => {
    assert.deepEqual({ ...(mergeEnvEntry(new EnvSpec({ default: 'a', secret: true, description: 'd' }), 'b') as EnvSpec) }, { value: 'b', secret: true, description: 'd' });
    assert.deepEqual({ ...(mergeEnvEntry(new EnvSpec({ value: 'a', required: true }), new EnvSpec({ default: 'b' })) as EnvSpec) }, { default: 'b', required: true });
    assert.deepEqual({ ...(mergeEnvEntry(new EnvSpec({ value: 'a', secret: true }), new EnvSpec({ secret: false })) as EnvSpec) }, { value: 'a', secret: false });
    assert.equal(mergeEnvEntry('plain', new EnvSpec({ default: 'x' })) instanceof EnvSpec, true);
    // docker.env, k8s.env and prod.env merge the same way.
    const cfg = await config(`services:
  api:
    command: x
    env: { TOKEN: { default: dev, secret: true } }
    docker: { image: node, env: { TOKEN: docker-value } }
    k8s: { env: { TOKEN: k8s-value } }
    prod: { env: { TOKEN: prod-value } }
`);
    for (const [view, value] of [
      [applyDockerMode(cfg), 'docker-value'],
      [applyK8sMode(cfg), 'k8s-value'],
      [applyProduction(cfg, true), 'prod-value'],
    ] as const) {
      const entry = view.services.api!.env.TOKEN as EnvSpec;
      assert.equal(entry.value, value);
      assert.equal(entry.secret, true, 'secret: true survives a plain override');
    }
  });

  it('masks what the config marks secret, and keeps secret: false visible', async () => {
    const cfg = await config(`services:
  api:
    command: x
    env:
      SESSION: { value: s, secret: true }
      PASSWORD_MIN_LENGTH: { value: '8', secret: false }
      DB_PASSWORD: pw
`);
    const secrets = new Map<string, boolean>();
    const printable = buildPrintableEnv(cfg, cfg.services.api!, {}, {}, {}, secrets);
    assert.deepEqual(
      maskSecrets({ SESSION: printable.SESSION!, PASSWORD_MIN_LENGTH: printable.PASSWORD_MIN_LENGTH!, DB_PASSWORD: printable.DB_PASSWORD! }, false, secrets),
      { SESSION: '***', PASSWORD_MIN_LENGTH: '8', DB_PASSWORD: '***' },
    );
  });
});

describe('required env', () => {
  it('reports every missing required: true value in one error, grouped by key, with descriptions', async () => {
    const cfg = await config(`env:
  STRIPE_KEY: { required: true, description: Test key from the Stripe dashboard }
services:
  api: { command: x, env: { RESEND_KEY: { required: true } } }
  worker: { command: x }
  web: { command: x, env: { STRIPE_KEY: pk_test } }
`);
    const error = () => assertEnvRequirements(cfg, ['api', 'worker', 'web'], {});
    assert.throws(error, (thrown: Error) => {
      assert.match(thrown.message, /required env are missing or empty \(required: true\)/);
      assert.match(thrown.message, /STRIPE_KEY \(service api, service worker\): Test key from the Stripe dashboard/);
      assert.match(thrown.message, /RESEND_KEY \(service api\)/);
      assert.doesNotMatch(thrown.message, /service web/, 'web sets the key itself');
      assert.match(thrown.message, /Set them in your shell or in a use_env file such as \.env\./);
      return true;
    });
    assert.doesNotThrow(() => assertEnvRequirements(cfg, ['api', 'worker'], { STRIPE_KEY: 'sk', RESEND_KEY: 're' }));
    // A value or a default satisfies it; an empty one does not.
    const filled = await config(`services:\n  api: { command: x, env: { A: { required: true, default: x }, B: { required: true, value: '' } } }\n`);
    assert.deepEqual(envRequirementProblems(filled, ['api'], {}).length, 1);
    assert.match(envRequirementProblems(filled, ['api'], {})[0]!, /B \(service api\)/);
  });

  it('treats required: prod like prod.require, and names it', async () => {
    const cfg = applyProduction(await config(STACK), true);
    assert.ok(requiredEnvKeys(cfg, cfg.services.api!).includes('SECRET'));
    const env = buildServiceEnv(cfg, cfg.services.api!, { STRIPE_KEY: 'sk' }, {}, assign(cfg, { db: 55432, api: 54000 }));
    assert.equal(env.env.SECRET, undefined, 'the development value is not used in production');
    assert.throws(() => assertEnvRequirements(cfg, ['api'], { STRIPE_KEY: 'sk' }), /service api requires SECRET in production \(required: prod\)/);
    assert.doesNotThrow(() => assertEnvRequirements(cfg, ['api'], { STRIPE_KEY: 'sk', SECRET: 's' }));
    // Development uses the config value and does not ask for it.
    const dev = await config(STACK);
    assert.doesNotThrow(() => assertEnvRequirements(dev, ['api'], { STRIPE_KEY: 'sk' }));
  });

  it('puts production and required: true problems in one error, and reports a project key once', async () => {
    const cfg = applyProduction(
      await config(`setup: echo
prod: { require: [DEPLOY_SECRET] }
env: { TOKEN: { required: prod, description: From the vault } }
services:
  api: { command: x, env: { STRIPE: { required: true } } }
`),
      true,
    );
    assert.throws(
      () => assertEnvRequirements(cfg, ['api'], {}),
      (thrown: Error) => {
        const lines = thrown.message.split('\n');
        assert.match(lines[0]!, /^the project requires DEPLOY_SECRET, TOKEN in production \(prod\.require: DEPLOY_SECRET; required: prod: TOKEN\)/);
        assert.match(thrown.message, /\n {2}TOKEN: From the vault/);
        assert.doesNotMatch(thrown.message, /service api requires/, 'the project already named them');
        assert.match(thrown.message, /STRIPE \(service api\)/);
        assert.match(thrown.message, /Supply it through the platform environment or a use_env file\.$/);
        return true;
      },
    );
  });
});

describe('mode-aware addresses and exports', () => {
  it('resolves address for where the reader runs', async () => {
    const local = await config(STACK);
    const assignments = assign(local, { db: 55432, api: 54000 });
    const read = (cfg: PortlerConfig, viewer?: 'host') =>
      withProcessEnv({ POSTGRES_PASSWORD: undefined }, () => buildServiceEnv(cfg, cfg.services.api!, { STRIPE_KEY: 'sk' }, buildGeneratedEnv(assignments), assignments, viewer ? { viewer } : {}).env);

    const host = read(local);
    assert.equal(host.DB_ADDRESS, 'localhost:55432', 'a host process reaches the published port');
    assert.equal(host.DATABASE_URL, 'postgres://app:devpass@localhost:55432/app');
    assert.equal(host.SELF, 'localhost:54000');

    const docker = read(applyDockerMode(local));
    assert.equal(docker.DB_ADDRESS, 'db:5432', 'a container reaches the alias and container port');
    assert.equal(docker.DB_HOST, 'db');
    assert.equal(docker.DB_PORT, '5432');
    assert.equal(docker.DATABASE_URL, 'postgres://app:devpass@db:5432/app');
    assert.equal(docker.SELF, 'api:4000');
    assert.equal(read(applyDockerMode(local), 'host').DB_ADDRESS, 'localhost:55432', 'setup steps and healthchecks read from this machine');

    const k8s = read(applyK8sMode(local));
    assert.equal(k8s.DB_ADDRESS, 'db:5432', 'a pod reaches the Kubernetes Service');
    assert.equal(k8s.DATABASE_URL, 'postgres://app:devpass@db:5432/app');
  });

  it('reaches a host process from a container through the host gateway name, and names k8s Services as Kubernetes does', async () => {
    const cfg = applyDockerMode(await config(`services:
  web: { command: x, port: 3000 }
  api: { command: x, port: 4000, docker: { image: node }, env: { WEB: web.address } }
`));
    const assignments = assign(cfg, { web: 53000, api: 54000 });
    assert.equal(buildServiceEnv(cfg, cfg.services.api!, {}, {}, assignments).env.WEB, 'host.docker.internal:53000');
    const k8s = applyK8sMode(await config(`services:\n  Db_Main: { image: postgres, port: 5432 }\n  api: { command: x, port: 4000, env: { DB: Db_Main.address } }\n`));
    assert.equal(buildServiceEnv(k8s, k8s.services.api!, {}, {}, assign(k8s, { Db_Main: 1, api: 2 })).env.DB, 'db-main:5432');
  });

  it('builds an export from the env the exporter really gets', async () => {
    const cfg = await config(STACK);
    const assignments = assign(cfg, { db: 55432, api: 54000 });
    const env = withProcessEnv({ POSTGRES_PASSWORD: 'from-shell' }, () => buildServiceEnv(cfg, cfg.services.api!, { STRIPE_KEY: 'sk' }, {}, assignments));
    assert.equal(env.env.DATABASE_URL, 'postgres://app:from-shell@localhost:55432/app', 'the shell overrides the default password');
    assert.equal(env.secrets.get('DATABASE_URL'), true, 'a value made from a secret is secret');
    const effective = new Map<string, boolean>();
    buildEffectiveEnv(cfg, cfg.services.api!, { STRIPE_KEY: 'sk' }, {}, assignments, effective);
    assert.equal(effective.get('DATABASE_URL'), true);
  });

  it('refuses exports that read exports, env.KEY outside exports, and self without a service', async () => {
    const cfg = await config(`services:
  a:
    command: x
    port: 1
    exports:
      one: \${b.two}
  b:
    command: x
    port: 2
    env:
      USES: \${a.one}
    exports:
      two: \${env.USES}
  c:
    command: x
    env:
      BAD: \${env.HOME}
`);
    const assignments = assign(cfg, { a: 50001, b: 50002 });
    assert.throws(() => resolveEnvValue('${a.one}', assignments, { config: cfg }), /export "a\.one" cannot use another export \("b\.two"\)/);
    assert.throws(() => buildServiceEnv(cfg, cfg.services.c!, {}, {}, assignments), /"env\.HOME" only works inside a service's exports/);
    assert.throws(() => resolveEnvValue('${self.port}', assignments, { config: cfg }), /"self" only works in a service's own env/);
    assert.throws(() => resolveEnvValue('a.nope', assignments, { config: cfg }), /unknown property "nope".*exports of a: one/);
    assert.equal(resolveEnvValue('${self.name}', {}, { config: cfg, self: 'c' }), 'c', 'a portless service has a name');
  });

  it('validates export names and reserves the self and env service names', async () => {
    await assert.rejects(config('services: {a: {command: x, exports: {url: x}}}'), /exports\.url would hide the built-in "url" property/);
    await assert.rejects(config('services: {a: {command: x, exports: {Bad: x}}}'), /export names use lowercase/);
    await assert.rejects(config('services: {self: {command: x}}'), /service name "self" is reserved/);
    await assert.rejects(config('services: {env: {command: x}}'), /service name "env" is reserved/);
  });
});

// REVIEW: Regression coverage for metadata-only scalar overrides and checking
// the winning value, not merely the existence of some non-empty input layer.
describe('env review regressions', () => {
  it('preserves scalar values when an override only adds metadata', () => {
    assert.deepEqual({ ...(mergeEnvEntry('root', new EnvSpec({ secret: true })) as EnvSpec) }, { value: 'root', secret: true });
  });

  it('requires the winning layer to be non-empty in dev, production and start', async () => {
    const cfg = await config(`services:
  api:
    command: x
    env:
      REVIEW_FIXED: { value: '', required: true }
      REVIEW_DEFAULT: { default: nonempty, required: true }
`);
    const supplied = { REVIEW_FIXED: 'shell', REVIEW_DEFAULT: '' };
    assert.match(envRequirementProblems(cfg, ['api'], supplied).join('\n'), /REVIEW_FIXED/);
    assert.match(envRequirementProblems(cfg, ['api'], supplied).join('\n'), /REVIEW_DEFAULT/);
    const prod = applyProduction(cfg, true);
    assert.doesNotMatch(envRequirementProblems(prod, ['api'], supplied).join('\n'), /REVIEW_FIXED/);
    assert.match(envRequirementProblems(prod, ['api'], supplied).join('\n'), /REVIEW_DEFAULT/);
    assert.doesNotMatch(envRequirementProblems(cfg, ['api'], supplied, { deploymentPrecedence: true }).join('\n'), /REVIEW_FIXED/);
    withProcessEnv({ REVIEW_DEFAULT: 'shell' }, () => {
      assert.match(envRequirementProblems(cfg, ['api'], { REVIEW_DEFAULT: '' }).join('\n'), /REVIEW_DEFAULT/);
    });
  });

  it('enforces required env in Kubernetes renders, aggregating all services', async () => {
    const cfg = applyK8sMode(await config(`services:
  a: { image: node, env: { FIRST: { required: true } } }
  b: { image: node, env: { SECOND: { required: true } } }
`));
    await assert.rejects(renderManifests(cfg, ['a', 'b'], {}), (error: Error) => {
      assert.match(error.message, /FIRST/);
      assert.match(error.message, /SECOND/);
      return true;
    });
  });

  it('does not let secret:false unmask a value derived from an exported secret', async () => {
    const cfg = await config(`services:
  db:
    command: x
    env: { SESSION: { value: private, secret: true } }
    exports: { credential: '\${env.SESSION}' }
  api:
    command: x
    env: { DISPLAY: { value: '\${db.credential}', secret: false } }
`);
    const built = buildServiceEnv(cfg, cfg.services.api!, {}, {}, {});
    assert.equal(maskSecrets({ DISPLAY: built.env.DISPLAY! }, false, built.secrets).DISPLAY, '***');
  });

  it('checks resolved empty references when composed envs are available', async () => {
    const cfg = await config(`services:
  api:
    command: x
    port: 3000
    env: { EMPTY: { value: '\${self.container}', required: true } }
`);
    const assignments = assign(cfg, { api: 53000 });
    const built = buildServiceEnv(cfg, cfg.services.api!, {}, {}, assignments);
    assert.equal(built.env.EMPTY, '');
    assert.throws(() => assertEnvRequirements(cfg, ['api'], {}, { envs: new Map([['api', built.env]]) }), /EMPTY/);
  });
});
