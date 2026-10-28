import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { applyDockerMode } from '../src/config/docker.ts';
import { EnvSpec } from '../src/config/env-spec.ts';
import { loadConfig } from '../src/config/loader.ts';
import { builtInPresetNames } from '../src/config/presets.ts';
import { parseYaml } from '../src/parse/yaml.ts';
import { buildServiceEnv } from '../src/env/service.ts';
import { resolveEnvValue } from '../src/env/resolve.ts';
import type { Assignments } from '../src/types/index.ts';

const dirs: string[] = [];
async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-presets-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('use: presets', () => {
  it('ships postgres, mysql and redis as plain YAML', async () => {
    assert.deepEqual(builtInPresetNames(), ['mysql', 'postgres', 'redis']);
    const presetDir = new URL('../presets/', import.meta.url);
    for (const name of builtInPresetNames()) {
      const preset = parseYaml(await fs.readFile(new URL(`${name}.yml`, presetDir), 'utf8'));
      assert.equal(typeof preset.image, 'string', `${name} names an image`);
      assert.match(String(preset.image), /:\d/, `${name} pins a version, so a data volume keeps opening`);
      assert.ok(preset.exports, `${name} exports a connection value`);
    }
  });

  it('starts a service from a built-in preset, with the own keys of the service on top', async () => {
    const dir = await project({
      'portler.yml': `services:
  db:
    use: postgres
    env:
      POSTGRES_DB: shop
      POSTGRES_PASSWORD: s3cret
  api:
    command: x
    port: 4000
    env:
      DATABASE_URL: \${db.database_url}
`,
    });
    const cfg = await loadConfig(dir);
    const db = cfg.services.db!;
    assert.equal(db.docker?.image, 'postgres:18-alpine');
    assert.equal(db.port, 5432);
    assert.deepEqual(db.docker?.volumes, ['@db-data:/var/lib/postgresql'], '${self.name} names the volume after the service');
    assert.deepEqual(cfg.volumes, [{ name: 'db-data', services: ['db'] }]);
    assert.equal(db.healthcheck?.type, 'command');
    const password = db.env.POSTGRES_PASSWORD as EnvSpec;
    assert.equal(password.value, 's3cret');
    assert.equal(password.secret, true, 'a plain value keeps the preset\'s secret: true');
    assert.equal((db.env.POSTGRES_USER as EnvSpec).default, 'postgres', 'keys the service does not set stay');

    const assignments: Assignments = {
      db: { name: 'db', port: 55432, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: 'http://localhost:55432', containerName: db.docker!.containerName },
      api: { name: 'api', port: 54000, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: 'http://localhost:54000' },
    };
    assert.equal(buildServiceEnv(cfg, cfg.services.api!, {}, {}, assignments).env.DATABASE_URL, 'postgres://postgres:s3cret@localhost:55432/shop');
    const docker = applyDockerMode(cfg);
    assert.equal(
      buildServiceEnv(docker, { ...docker.services.api!, docker: { image: 'node', containerName: 'c', volumes: [], env: {} } }, {}, {}, assignments).env.DATABASE_URL,
      'postgres://postgres:s3cret@db:5432/shop',
    );
    assert.equal(
      resolveEnvValue(db.healthcheck!.command!, assignments, { config: cfg, self: 'db' }),
      `docker exec ${db.docker!.containerName} pg_isready -h 127.0.0.1 -p 5432`,
    );
  });

  it('gives two services that use the same preset their own volumes', async () => {
    const cfg = await loadConfig(await project({ 'portler.yml': 'services:\n  main: {use: postgres}\n  analytics: {use: postgres}\n' }));
    assert.deepEqual(cfg.volumes.map((volume) => volume.name).sort(), ['analytics-data', 'main-data']);
  });

  it('reads a preset file of the project, relative to the project root', async () => {
    const dir = await project({
      'presets/cache.yml': 'image: valkey/valkey:8\nport: 6379\nexports:\n  cache_url: redis://${self.address}\n',
      'portler.yml': 'services:\n  cache:\n    use: ./presets/cache.yml\n    port: 6380\n',
    });
    const cfg = await loadConfig(dir);
    assert.equal(cfg.services.cache!.docker?.image, 'valkey/valkey:8');
    assert.equal(cfg.services.cache!.port, 6380, 'the service replaces a preset key');
    assert.deepEqual({ ...cfg.services.cache!.exports }, { cache_url: 'redis://${self.address}' });
  });

  it('names what is wrong with a preset', async () => {
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgress}}' })), /no built-in preset "postgress".*did you mean "postgres"/s);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: ./missing.yml}}' })), /services\.db\.use: cannot read preset file .*missing\.yml/);
    await assert.rejects(
      loadConfig(await project({ 'a.yml': 'use: postgres\n', 'portler.yml': 'services: {db: {use: ./a.yml}}' })),
      /a preset cannot use another preset/,
    );
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: 4}}' })), /services\.db\.use must be a preset name or a path/);
  });
});
