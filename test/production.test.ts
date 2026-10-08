import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { main } from '../src/cli/index.ts';
import { loadConfig } from '../src/config/loader.ts';
import { applyDockerMode } from '../src/config/docker.ts';
import { applyProduction } from '../src/config/production.ts';

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
    assert.deepEqual(dev.setup, ['npm install']);
    assert.equal(applyProduction(dev), dev);
    assert.deepEqual(prod.setup, ['npm ci', 'npm run build']);
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
    assert.deepEqual(prod.services.prod?.setup, ['echo service']);
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
    for (const prod of [applyProduction(dev, true), applyProduction(applyDockerMode(dev), true)]) {
      assert.equal(prod.services.api?.docker?.command, 'node server.js');
      assert.equal(prod.services.api?.env.LOG_LEVEL, 'info');
    }
  });

  for (const [text, error] of [
    ['setup: 42\nservices: {api: {command: echo}}', /setup must be a string or a list/],
    ['services: {api: {setup: [echo, 42]}}', /services.api.setup must be a string or a list/],
    ['prod: nope\nservices: {api: {command: echo}}', /prod must be an object/],
    ['prod: {command: echo}\nservices: {api: {command: echo}}', /unknown key "prod.command"/],
    ['services: {api: {prod: {cwd: other}}}', /unknown key "services.api.prod.cwd"/],
    ['services: {api: {prod: {command: 4}}}', /services.api.prod.command must be a string/],
    ['services: {api: {prod: {setup: false}}}', /services.api.prod.setup must be a string or a list/],
    ['prod: {env: 5}\nservices: {api: {command: echo}}', /prod.env must be a mapping/],
    ['setup: null\nservices: {api: {command: echo}}', /setup must be a string or a list/],
  ] as const) {
    it(`rejects invalid config: ${text.split('\n')[0]}`, async () => {
      await assert.rejects(config(text), error);
    });
  }

  it('validates flag combinations and rejects unsupported k8s flags before loading config', async () => {
    assert.equal(parseArgs(['--no-setup'], 'up').setup, false);
    assert.throws(() => parseArgs(['--setup', '--no-setup'], 'up'), /cannot be combined/);
    await assert.rejects(main(['start', '--setup']), /does not apply/);
    await assert.rejects(main(['down', '--prod']), /does not apply/);
    await assert.rejects(main(['up', 'k8s', '--prod']), /do not apply to k8s/);
  });
});
