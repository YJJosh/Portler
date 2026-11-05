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
      assert.match(String(preset.image), /:\$\{version\}/, `${name} takes its image tag from the version`);
      assert.ok(Object.keys(preset.versions as object).length > 1, `${name} lists its versions, so a data volume keeps opening`);
      assert.ok(preset.exports, `${name} exports a connection value`);
    }
  });

  it('starts a service from a built-in preset, with the own keys of the service on top', async () => {
    const dir = await project({
      'portler.yml': `services:
  db:
    use: postgres@18
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
    const cfg = await loadConfig(await project({ 'portler.yml': 'services:\n  main: {use: postgres@18}\n  analytics: {use: postgres@18}\n' }));
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

  it('uses the data path of the chosen Postgres version', async () => {
    const cfg = await loadConfig(await project({ 'portler.yml': 'services:\n  old: {use: postgres@16}\n  new: {use: postgres@18}\n' }));
    assert.equal(cfg.services.old!.docker?.image, 'postgres:16-alpine');
    assert.deepEqual(cfg.services.old!.docker?.volumes, ['@old-data:/var/lib/postgresql/data']);
    assert.equal(cfg.services.new!.docker?.image, 'postgres:18-alpine');
    assert.deepEqual(cfg.services.new!.docker?.volumes, ['@new-data:/var/lib/postgresql']);
  });

  it('loads every version of every built-in preset', async () => {
    const presetDir = new URL('../presets/', import.meta.url);
    for (const name of builtInPresetNames()) {
      const preset = parseYaml(await fs.readFile(new URL(`${name}.yml`, presetDir), 'utf8'));
      for (const version of Object.keys(preset.versions as object)) {
        const cfg = await loadConfig(await project({ 'portler.yml': `services:\n  db:\n    use: ${name}@${version}\n` }));
        assert.ok(cfg.services.db!.docker?.image.includes(`:${version}`), `${name}@${version}`);
        assert.ok(!JSON.stringify(cfg.services.db).includes('${version}'), `${name}@${version} replaces every placeholder`);
      }
    }
  });

  it('merges env and exports of a version with the preset, and the service on top', async () => {
    const dir = await project({
      'db.yml': `image: acme/db:\${version}
port: 5000
env:
  USER_NAME: { default: app }
  PASSWORD: { default: dev, secret: true }
  DROPPED_NOTHING: kept
exports:
  a_url: a://\${self.address}
versions:
  "2":
    port: 6000
    env:
      EXTRA_FLAG: "1"
      PASSWORD: { description: From version 2 }
    exports:
      b_url: b://\${self.address}
`,
      'portler.yml': 'services:\n  db:\n    use: ./db.yml@2\n    env:\n      USER_NAME: me\n',
    });
    const db = (await loadConfig(dir)).services.db!;
    assert.equal(db.port, 6000, 'other keys of a version replace the preset\'s');
    assert.equal(db.env.DROPPED_NOTHING, 'kept');
    assert.equal(db.env.EXTRA_FLAG, '1');
    const password = db.env.PASSWORD as EnvSpec;
    assert.deepEqual([password.default, password.secret, password.description], ['dev', true, 'From version 2']);
    assert.equal((db.env.USER_NAME as EnvSpec).value, 'me');
    assert.deepEqual({ ...db.exports }, { a_url: 'a://${self.address}', b_url: 'b://${self.address}' });
  });

  it('lets the service replace the keys of a version', async () => {
    const cfg = await loadConfig(await project({ 'portler.yml': "services:\n  db:\n    use: postgres@16\n    volumes: ['@mine:/pg']\n" }));
    assert.deepEqual(cfg.services.db!.docker?.volumes, ['@mine:/pg']);
  });

  it('never picks a version for a preset that lists them', async () => {
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgres}}' })), /preset "postgres" needs a version, for example "postgres@18"\. Versions: 18, 17, 16, 15, 14/);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgres@99}}' })), /preset "postgres" has no version "99"\. Versions: 18, 17.*keep a listed one here and set image: and volumes:/);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgres@__proto__}}' })), /has no version "__proto__"/);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgres@}}' })), /has no version ""/);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgress@16}}' })), /no built-in preset "postgress".*did you mean "postgres"/s);
  });

  it('gives a preset file of the project versions too', async () => {
    const files = {
      'db.yml': 'image: acme/db:${version}\nversions:\n  "2":\n  "1":\n    port: 1111\n',
      'plain@2.yml': 'image: acme/plain:1\n',
    };
    const dir = await project({ ...files, 'portler.yml': 'services:\n  one: {use: ./db.yml@1}\n  plain: {use: ./plain@2.yml}\n' });
    const cfg = await loadConfig(dir);
    assert.equal(cfg.services.one!.docker?.image, 'acme/db:1');
    assert.equal(cfg.services.one!.port, 1111);
    assert.equal(cfg.services.plain!.docker?.image, 'acme/plain:1', 'an @ in the file name is not a version');
    await assert.rejects(loadConfig(await project({ ...files, 'portler.yml': 'services: {db: {use: ./plain@2.yml@3}}' })), /has no versions, so "@3" means nothing/);
    await assert.rejects(loadConfig(await project({ 'v.yml': 'image: x\nversions: [1]\n', 'portler.yml': 'services: {db: {use: ./v.yml@1}}' })), /must list its versions as a mapping/);
    await assert.rejects(loadConfig(await project({ 'v.yml': 'image: x\nversions:\n  "1": nope\n', 'portler.yml': 'services: {db: {use: ./v.yml@1}}' })), /version "1" of preset .* must be a mapping/);
  });

  // REVIEW: the three cases below passed silently with a wrong or literal value before the fix.
  it('rejects a preset that uses ${version} without listing versions', async () => {
    await assert.rejects(
      loadConfig(await project({ 'p.yml': 'image: acme/db:${version}\n', 'portler.yml': 'services: {db: {use: ./p.yml}}' })),
      /uses \$\{version\} but lists no versions/,
    );
  });

  it('keeps a flow-style version key as written, and inserts $-patterns literally', async () => {
    const files = { 'p.yml': 'image: acme/db:${version}\nversions: {8.0: {}, "2$&": {}}\n' };
    const cfg = await loadConfig(await project({ ...files, 'portler.yml': 'services: {db: {use: ./p.yml@8.0}}' }));
    assert.equal(cfg.services.db!.docker?.image, 'acme/db:8.0');
    const odd = await loadConfig(await project({ ...files, 'portler.yml': 'services:\n  db:\n    use: "./p.yml@2$&"\n' }));
    assert.equal(odd.services.db!.docker?.image, 'acme/db:2$&');
  });

  it('names what is wrong with a preset', async () => {
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: postgress}}' })), /no built-in preset "postgress".*did you mean "postgres"/s);
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: ./missing.yml}}' })), /services\.db\.use: cannot read preset file .*missing\.yml/);
    await assert.rejects(
      loadConfig(await project({ 'a.yml': 'use: postgres@18\n', 'portler.yml': 'services: {db: {use: ./a.yml}}' })),
      /a preset cannot use another preset/,
    );
    await assert.rejects(loadConfig(await project({ 'portler.yml': 'services: {db: {use: 4}}' })), /services\.db\.use must be a preset name or a path/);
  });
});
