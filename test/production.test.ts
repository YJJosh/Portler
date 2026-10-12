import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { main } from '../src/cli/index.ts';
import { loadConfig } from '../src/config/loader.ts';
import { applyDockerMode } from '../src/config/docker.ts';
import { applyProduction, productionServices } from '../src/config/production.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dirs: string[] = [];
async function config(text: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-production-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'portler.yml'), text);
  return loadConfig(dir);
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('production config', () => {
  it('normalizes setup and replaces commands while merging env at each level', async () => {
    const dev = await config(`setup: npm install
env: {KEEP: yes, NODE_ENV: development}
prod:
  setup: [npm ci, npm run build]
  env: {NODE_ENV: production}
services:
  api:
    command: npm run dev
    setup: npm generate
    env: {KEEP_SERVICE: yes, LOG_LEVEL: debug}
    prod:
      command: npm start
      setup: []
      env: {LOG_LEVEL: info}
`);
    const prod = applyProduction(dev, true);
    assert.equal(prod.production, true);
    assert.equal(dev.production, undefined);
    assert.deepEqual(dev.setup, [{ run: 'npm install' }]);
    assert.equal(applyProduction(dev), dev);
    assert.deepEqual(prod.setup, [{ run: 'npm ci' }, { run: 'npm run build' }]);
    assert.deepEqual(prod.env, { KEEP: 'yes', NODE_ENV: 'production' });
    assert.equal(prod.services.api?.command, 'npm start');
    assert.deepEqual(prod.services.api?.setup, []);
    assert.deepEqual(prod.services.api?.env, { KEEP_SERVICE: 'yes', LOG_LEVEL: 'info' });
    assert.equal(dev.services.api?.command, 'npm run dev');
  });

  it('falls back to dev definitions when prod omits them, and allows a service named prod', async () => {
    const dev = await config('setup: echo root\nservices:\n  prod:\n    command: echo dev\n    setup: echo service\n');
    const prod = applyProduction(dev, true);
    assert.deepEqual(prod.setup, dev.setup);
    assert.equal(prod.services.prod?.command, 'echo dev');
    assert.deepEqual(prod.services.prod?.setup, [{ run: 'echo service' }]);
    assert.deepEqual(parseArgs(['prod', '--prod'], 'up').positionals, ['prod']);
  });

  it('applies production command and env after Docker mode overrides', async () => {
    const dev = await config(`services:
  api:
    command: local-dev
    image: node:22
    docker:
      image: node:22-alpine
      command: docker-dev
      env: {LOG_LEVEL: debug}
    prod:
      command: node server.js
      env: {LOG_LEVEL: info}
`);
    const local = applyProduction(dev, true);
    const docker = applyProduction(applyDockerMode(dev), true);
    // The always-Docker container runs `command`, so prod replaces it; the
    // `docker:` block describes its own container and keeps its command.
    assert.equal(local.services.api?.docker?.command, 'node server.js');
    assert.equal(docker.services.api?.docker?.command, 'docker-dev');
    for (const prod of [local, docker]) assert.equal(prod.services.api?.env.LOG_LEVEL, 'info');
  });

  it('keeps the image command for a docker block without one in prod Docker mode', async () => {
    const dev = await config(`services:
  web:
    command: next dev
    cwd: apps/web
    docker:
      build: .
    prod:
      command: next start
`);
    const prod = applyProduction(applyDockerMode(dev), true);
    assert.equal(prod.services.web?.command, 'next start');
    assert.equal(prod.services.web?.docker?.command, undefined);
  });

  it('keeps an explicit docker command even when it is spelled like the local one', async () => {
    const dev = await config(`services:
  api:
    command: npm run dev
    docker:
      image: node:22-alpine
      command: npm run dev
    prod:
      command: node server.js
`);
    const prod = applyProduction(applyDockerMode(dev), true);
    assert.equal(prod.services.api?.command, 'node server.js');
    assert.equal(prod.services.api?.docker?.command, 'npm run dev');

    // `docker: true` points at the always-Docker config, whose container
    // runs `command`, so there prod replaces it.
    const inherited = await config(`services:
  api:
    command: npm run dev
    image: node:22
    docker: true
    prod:
      command: node server.js
`);
    assert.equal(applyProduction(applyDockerMode(inherited), true).services.api?.docker?.command, 'node server.js');
  });

  it('accepts if_missing and always steps next to plain commands', async () => {
    const cfg = await config(`setup:
  - pnpm install
  - run: pnpm install
    if_missing: node_modules
  - {run: pnpm build, always: true}
  - {run: pnpm generate, always: false}
prod:
  setup: {run: pnpm build, always: true}
services:
  api:
    command: echo
    setup: {run: pnpm generate, if_missing: src/generated}
`);
    assert.deepEqual(cfg.setup, [
      { run: 'pnpm install' },
      { run: 'pnpm install', ifMissing: 'node_modules' },
      { run: 'pnpm build', always: true },
      { run: 'pnpm generate' },
    ]);
    assert.deepEqual(cfg.prod?.setup, [{ run: 'pnpm build', always: true }]);
    assert.deepEqual(cfg.services.api?.setup, [{ run: 'pnpm generate', ifMissing: 'src/generated' }]);
  });

  for (const [text, error] of [
    ['setup: 42\nservices: {api: {command: echo}}', /setup must be a string or a list/],
    ['services: {api: {setup: [echo, 42]}}', /services.api.setup\[1\] must be a command string or a \{run, if_missing, always, watch\} step/],
    ['setup: [{if_missing: node_modules}]\nservices: {api: {command: echo}}', /setup\[0\].run must be a shell command/],
    ['setup: ""\nservices: {api: {command: echo}}', /setup must be a shell command/],
    ['services: {api: {setup: ["   "]}}', /services.api.setup\[0\] must be a shell command/],
    ['services: {api: {prod: {setup: " "}}}', /services.api.prod.setup must be a shell command/],
    ['setup: [{run: "", always: true}]\nservices: {api: {command: echo}}', /setup\[0\].run must be a shell command/],
    ['setup: [{run: x, if_missing: ""}]\nservices: {api: {command: echo}}', /setup\[0\].if_missing must be a path/],
    ['setup: [{run: x, if_missing: y, always: true}]\nservices: {api: {command: echo}}', /setup\[0\] cannot combine if_missing with always/],
    ['setup: [{run: x, always: yes}]\nservices: {api: {command: echo}}', /setup\[0\].always must be true or false/],
    ['setup: [{run: x, cwd: y}]\nservices: {api: {command: echo}}', /unknown key "setup\[0\].cwd"; allowed keys: run, if_missing, always, watch/],
    ['services: {api: {prod: {setup: [{run: x, when: y}]}}}', /unknown key "services.api.prod.setup\[0\].when"/],
    ['prod: nope\nservices: {api: {command: echo}}', /prod must be an object/],
    ['prod: {command: echo}\nservices: {api: {command: echo}}', /unknown key "prod.command"/],
    ['services: {api: {prod: {cwd: other}}}', /unknown key "services.api.prod.cwd"/],
    ['services: {api: {prod: {command: 4}}}', /services.api.prod.command must be a string/],
    ['services: {api: {prod: {setup: false}}}', /services.api.prod.setup must be a string or a list/],
    ['prod: {env: 5}\nservices: {api: {command: echo}}', /prod.env must be a mapping/],
    ['setup: null\nservices: {api: {command: echo}}', /setup must be a string or a list/],
    ['setup: [{run: x, watch: []}]\nservices: {api: {command: echo}}', /setup\[0\].watch must list at least one file/],
    ['setup: [{run: x, watch: [""]}]\nservices: {api: {command: echo}}', /setup\[0\].watch must not contain an empty path/],
    ['setup: [{run: x, watch: 4}]\nservices: {api: {command: echo}}', /setup\[0\].watch must be a file path or a list/],
    ['setup: [{run: x, watch: [f], always: true}]\nservices: {api: {command: echo}}', /setup\[0\] cannot combine watch with always/],
    ['setup: [{run: x, watch: [f], if_missing: p}]\nservices: {api: {command: echo}}', /setup\[0\] cannot combine watch with if_missing/],
    ['prod: {require: [bad-key]}\nservices: {api: {command: echo}}', /prod.require\[0\] must be an environment variable name/],
    ['prod: {require: 7}\nservices: {api: {command: echo}}', /prod.require must be a variable name or a list/],
    ['prod: {services: []}\nservices: {api: {command: echo}}', /prod.services must list at least one service/],
    ['prod: {services: [ghost]}\nservices: {api: {command: echo}}', /prod.services names unknown service "ghost"/],
    ['services: {api: {prod: {services: [api]}}}', /unknown key "services.api.prod.services"/],
  ] as const) {
    it(`rejects invalid config: ${text.split('\n')[0]}`, async () => {
      await assert.rejects(config(text), error);
    });
  }

  it('normalizes require, services and watch', async () => {
    const cfg = await config(`prod: {require: [SECRET, SECRET, DATABASE_URL], services: [api]}
setup: [{run: pnpm install, watch: pnpm-lock.yaml}]
services:
  api: {command: echo, prod: {require: TOKEN}}
  db: {image: postgres:16}
`);
    assert.deepEqual(cfg.prod?.require, ['SECRET', 'DATABASE_URL']);
    assert.deepEqual(cfg.prod?.services, ['api']);
    assert.deepEqual(cfg.services.api!.prod?.require, ['TOKEN']);
    assert.deepEqual(cfg.setup, [{ run: 'pnpm install', watch: ['pnpm-lock.yaml'] }]);
  });

  it('runs only prod.services under --prod and drops dependencies on the rest', async () => {
    const cfg = await config(`prod: {services: [api, web]}
services:
  postgres: {image: postgres:16, port: 5432}
  api: {command: echo, port: 4000, depends_on: [postgres]}
  web: {command: echo, port: 3000, depends_on: [api]}
`);
    assert.deepEqual(Object.keys(productionServices(cfg, false).services), ['postgres', 'api', 'web']);
    const prod = productionServices(cfg, true);
    assert.deepEqual(Object.keys(prod.services), ['api', 'web']);
    assert.deepEqual(prod.services.api!.dependsOn, []);
    assert.deepEqual(prod.services.web!.dependsOn.map((dependency) => dependency.service), ['api']);
    assert.deepEqual(Object.keys(applyProduction(cfg, true).services), ['api', 'web'], 'applyProduction applies the list too');
    assert.throws(() => productionServices(cfg, true, ['postgres']), /service "postgres" is not in prod.services/);
    assert.doesNotThrow(() => productionServices(cfg, true, ['api']));
  });

  it('refuses a proxy route to a service that prod.services leaves out', async () => {
    const cfg = await config(`prod: {services: [web]}
proxy: {port: auto, routes: {/api: api, /: web}}
services:
  api: {command: echo, port: 4000}
  web: {command: echo, port: 3000}
`);
    assert.throws(() => productionServices(cfg, true), /proxy route \/api targets service "api", which prod.services leaves out/);
  });

  it('env --prod prints the deployment view with secrets masked, and --reveal shows them', async () => {
    const cfg = await config(`prod: {require: [API_TOKEN]}
services:
  api:
    command: echo
    port: 4000
    env: {DATABASE_URL: "postgres://app:hunter2@localhost:5432/app", PLAIN: dev}
    prod: {env: {PLAIN: ''}}
`);
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    const env: Record<string, string> = { ...(process.env as Record<string, string>), PORTLER_GLOBAL_DIR: path.join(cfg.projectDir, 'global'), API_TOKEN: 'abc', PLAIN: 'from-platform' };
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, ['--experimental-strip-types', cli, 'env', 'api', '--prod', ...extra], { cwd: cfg.projectDir, env, encoding: 'utf8' });
    const masked = run();
    assert.equal(masked.status, 0, masked.stderr);
    assert.match(masked.stdout, /^API_TOKEN="?\*\*\*"?$/m);
    assert.match(masked.stdout, /^DATABASE_URL="?postgres:\/\/app:\*\*\*@localhost:5432\/app"?$/m);
    assert.match(masked.stdout, /^PLAIN="?from-platform"?$/m, 'the platform wins over the blank prod.env entry');
    assert.match(run('--reveal').stdout, /^API_TOKEN="?abc"?$/m);
    delete env.API_TOKEN;
    const missing = run();
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stderr, /service api requires API_TOKEN in production/);
    assert.doesNotMatch(missing.stdout, /^API_TOKEN=/m);
    const dev = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'env', 'api', '--reveal'], { cwd: cfg.projectDir, env, encoding: 'utf8' });
    assert.equal(dev.status, 1);
    assert.match(dev.stderr, /--reveal applies to "env --prod"/);
  });

  it('validates flag combinations and rejects unsupported k8s flags before loading config', async () => {
    assert.equal(parseArgs(['--no-setup'], 'up').setup, false);
    assert.throws(() => parseArgs(['--setup', '--no-setup'], 'up'), /cannot be combined/);
    await assert.rejects(main(['start', '--setup']), /does not apply/);
    await assert.rejects(main(['down', '--prod']), /does not apply/);
    await assert.rejects(main(['up', 'k8s', '--prod']), /do not apply to k8s/);
  });
});
