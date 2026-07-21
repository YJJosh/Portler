import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { findConfigFile, loadBaseEnv, loadConfig, resolveServiceCwd } from '../src/config/loader.ts';
import { DEFAULT_PORT_RANGE } from '../src/constants.ts';

const tempDirs: string[] = [];

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-project-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('findConfigFile', () => {
  it('finds portler.yml and portler.yaml', async () => {
    const ymlDir = await makeProject({ 'portler.yml': 'services:\n  api:\n    port: 3000\n' });
    assert.equal(await findConfigFile(ymlDir), path.join(ymlDir, 'portler.yml'));

    const yamlDir = await makeProject({ 'portler.yaml': 'services:\n  api:\n    port: 3000\n' });
    assert.equal(await findConfigFile(yamlDir), path.join(yamlDir, 'portler.yaml'));
  });

  it('resolves an explicit config file and validates its existence', async () => {
    const dir = await makeProject({ 'custom.yml': 'services: {}\n' });
    assert.equal(await findConfigFile(dir, 'custom.yml'), path.join(dir, 'custom.yml'));
    await assert.rejects(findConfigFile(dir, 'missing.yml'), /config file not found/);
  });

  it('rejects when no config exists', async () => {
    const dir = await makeProject({});
    await assert.rejects(findConfigFile(dir), /could not find portler\.yml/);
  });
});

describe('loadConfig', () => {
  it('loads and normalizes a realistic config', async () => {
    const dir = await makeProject({
      'portler.yml': [
        'use_env: .env',
        'prefer_declared_port: true',
        'services:',
        '  postgres:',
        '    image: postgres:16-alpine',
        '    port: 5432',
        '    healthcheck:',
        '      command: pg_isready',
        '  backend:',
        '    command: npm run dev',
        '    cwd: backend',
        '    port: 4000',
        '    port_env: PORT',
        '    prefer_declared_port: false',
        '    depends_on:',
        '      - postgres',
        '    env:',
        '      DATABASE_URL: postgres://app@localhost:${postgres.port}/app',
        '',
      ].join('\n'),
    });

    const config = await loadConfig(dir);

    assert.equal(config.projectDir, dir);
    assert.equal(config.filePath, path.join(dir, 'portler.yml'));
    assert.deepEqual(config.useEnv, ['.env']);
    assert.deepEqual(config.portRange, DEFAULT_PORT_RANGE);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.urlHost, 'localhost');
    assert.equal(config.protocol, 'http');

    const postgres = config.services.postgres!;
    assert.equal(postgres.port, 5432);
    assert.ok(postgres.docker, 'image should make postgres a Docker service');
    assert.equal(postgres.docker.image, 'postgres:16-alpine');
    assert.equal(postgres.healthcheck?.type, 'command');
    assert.equal(postgres.healthcheck?.command, 'pg_isready');
    assert.equal(postgres.preferDeclaredPort, true, 'root prefer_declared_port should apply');

    const backend = config.services.backend!;
    assert.equal(backend.command, 'npm run dev');
    assert.equal(backend.cwd, 'backend');
    assert.deepEqual(backend.portEnv, ['PORT']);
    assert.equal(backend.preferDeclaredPort, false, 'service override should win');
    assert.deepEqual(backend.dependsOn, [{ service: 'postgres', condition: 'ready' }]);
    assert.equal(backend.docker, undefined);
    assert.equal(resolveServiceCwd(config, backend), path.join(dir, 'backend'));
  });

  it('applies root host/url_host/protocol with service overrides', async () => {
    const dir = await makeProject({
      'portler.yml': [
        'host: 0.0.0.0',
        'url_host: dev.local',
        'protocol: https',
        'services:',
        '  api:',
        '    port: 3000',
        '  other:',
        '    port: 3001',
        '    protocol: http',
        '',
      ].join('\n'),
    });

    const config = await loadConfig(dir);
    assert.equal(config.services.api?.host, '0.0.0.0');
    assert.equal(config.services.api?.urlHost, 'dev.local');
    assert.equal(config.services.api?.protocol, 'https');
    assert.equal(config.services.other?.protocol, 'http');
  });

  it('parses port ranges from port_range or port_start/port_end', async () => {
    const dir = await makeProject({
      'portler.yml': ['port_range:', '  start: 40000', '  end: 40100', 'services:', '  api:', '    port: 3000', ''].join('\n'),
    });
    assert.deepEqual((await loadConfig(dir)).portRange, { start: 40000, end: 40100 });

    const flatDir = await makeProject({
      'portler.yml': ['port_start: 41000', 'port_end: 41100', 'services:', '  api:', '    port: 3000', ''].join('\n'),
    });
    assert.deepEqual((await loadConfig(flatDir)).portRange, { start: 41000, end: 41100 });
  });

  it('rejects invalid port_range objects', async () => {
    const dir = await makeProject({
      'portler.yml': ['port_range:', '  start: 5000', '  end: 4000', 'services:', '  api:', '    port: 3000', ''].join('\n'),
    });
    await assert.rejects(loadConfig(dir), /invalid port range 5000-4000/);
  });

  it('rejects configs without services', async () => {
    const missing = await makeProject({ 'portler.yml': 'host: 127.0.0.1\n' });
    await assert.rejects(loadConfig(missing), /must contain a top-level "services:" mapping/);

    const empty = await makeProject({ 'portler.yml': 'services:\n' });
    await assert.rejects(loadConfig(empty), /must contain a top-level "services:" mapping/);
  });

  it('rejects the reserved service name "docker"', async () => {
    const dir = await makeProject({
      'portler.yml': ['services:', '  docker:', '    port: 3000', ''].join('\n'),
    });
    await assert.rejects(loadConfig(dir), /service name "docker" is reserved/);
  });

  it('rejects path/prototype-unsafe service names before they can become log paths or record keys', async () => {
    for (const serviceName of ['../../outside', '__proto__', 'has space', '💥']) {
      const dir = await makeProject({
        'portler.yml': ['services:', `  "${serviceName}":`, '    command: x', ''].join('\n'),
      });
      await assert.rejects(loadConfig(dir), /invalid service name/);
    }
  });

  it('rejects service names that collapse onto the same generated env prefix', async () => {
    for (const [left, right, prefix] of [
      ['api-main', 'api_main', 'API_MAIN'],
      // buildGeneratedEnv strips trailing punctuation; validation must use the
      // same normalization rather than let the second service overwrite api.
      ['api', 'api-', 'API'],
    ]) {
      const dir = await makeProject({
        'portler.yml': ['services:', `  ${left}:`, '    port: 3000', `  ${right}:`, '    port: 3001', ''].join('\n'),
      });
      await assert.rejects(loadConfig(dir), new RegExp(`both generate PORTLER_${prefix}_\\*`));
    }
  });

  it('rejects explicit healthchecks that cannot probe anything', async () => {
    const command = await makeProject({
      'portler.yml': ['services:', '  api:', '    command: x', '    healthcheck: command', ''].join('\n'),
    });
    await assert.rejects(loadConfig(command), /healthcheck\.command is required/);

    const tcp = await makeProject({
      'portler.yml': ['services:', '  api:', '    command: x', '    healthcheck: tcp', ''].join('\n'),
    });
    await assert.rejects(loadConfig(tcp), /type "tcp" requires services\.api\.port/);

    const http = await makeProject({
      'portler.yml': ['services:', '  api:', '    command: x', '    healthcheck: http', ''].join('\n'),
    });
    await assert.rejects(loadConfig(http), /type "http" requires a url or services\.api\.port/);
  });

  it('rejects managed volume names that normalize ambiguously', async () => {
    const unicode = await makeProject({
      'portler.yml': ['services:', '  db:', '    image: postgres', "    volumes: ['@💥:/data']", ''].join('\n'),
    });
    await assert.rejects(loadConfig(unicode), /must contain at least one ASCII letter or digit/);

    const collision = await makeProject({
      'portler.yml': [
        'services:',
        '  one:',
        '    image: postgres',
        "    volumes: ['@foo bar:/data']",
        '  two:',
        '    image: postgres',
        "    volumes: ['@foo@bar:/data']",
        '',
      ].join('\n'),
    });
    await assert.rejects(loadConfig(collision), /both normalize to "foo-bar"/);
  });

  it('rejects depends_on referencing unknown services', async () => {
    const dir = await makeProject({
      'portler.yml': ['services:', '  api:', '    port: 3000', '    depends_on:', '      - ghost', ''].join('\n'),
    });
    await assert.rejects(loadConfig(dir), /depends on unknown service "ghost"/);
  });

  it('rejects non-integer ports', async () => {
    const dir = await makeProject({
      'portler.yml': ['services:', '  api:', '    port: soon', ''].join('\n'),
    });
    await assert.rejects(loadConfig(dir), /services\.api\.port must be an integer/);
  });
});

describe('loadBaseEnv', () => {
  it('merges use_env files in order, later files winning', async () => {
    const dir = await makeProject({
      'portler.yml': ['use_env:', '  - .env', '  - .env.local', 'services:', '  api:', '    port: 3000', ''].join('\n'),
      '.env': 'SHARED=base\nBASE_ONLY=1\n',
      '.env.local': 'SHARED=local\n',
    });

    const config = await loadConfig(dir);
    assert.deepEqual(await loadBaseEnv(config), { SHARED: 'local', BASE_ONLY: '1' });
  });

  it('rejects missing env files', async () => {
    const dir = await makeProject({
      'portler.yml': ['use_env: .env.missing', 'services:', '  api:', '    port: 3000', ''].join('\n'),
    });
    const config = await loadConfig(dir);
    await assert.rejects(loadBaseEnv(config), /env file "\.env\.missing" listed in use_env was not found/);
  });
});
