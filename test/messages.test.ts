import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureNoOverlap } from '../src/cli/services.ts';
import { assertRequiredEnv } from '../src/env/index.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const projects: string[] = [];

afterEach(async () => {
  for (const projectDir of projects.splice(0)) {
    portler(projectDir, 'down');
    await fs.rm(path.dirname(projectDir), { recursive: true, force: true });
  }
});

async function project(yaml: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-messages-')));
  const projectDir = path.join(dir, 'app');
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, 'portler.yml'), yaml);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(projectDir, name), content);
  projects.push(projectDir);
  return projectDir;
}

function portler(projectDir: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORTLER_GLOBAL_DIR: path.join(path.dirname(projectDir), 'global') };
  delete env.PORT;
  delete env.PUBLIC_URL;
  delete env.ADMIN_TOKEN;
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: projectDir, env, encoding: 'utf8' });
}

const server = "require('http').createServer((_, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n";

describe('a missing production key', () => {
  it('names the prod.env line that left it blank, not prod.require', () => {
    assert.throws(() => assertRequiredEnv('service web', ['PUBLIC_URL'], {}, new Set(['PUBLIC_URL'])), /requires PUBLIC_URL in production \(left blank in prod\.env\)/);
    assert.throws(() => assertRequiredEnv('service web', ['ADMIN_TOKEN'], {}, new Set()), /requires ADMIN_TOKEN in production \(prod\.require\)/);
    assert.throws(
      () => assertRequiredEnv('service web', ['ADMIN_TOKEN', 'PUBLIC_URL'], {}, new Set(['PUBLIC_URL'])),
      /requires ADMIN_TOKEN, PUBLIC_URL in production \(prod\.require: ADMIN_TOKEN; left blank in prod\.env: PUBLIC_URL\)/,
    );
  });

  it('says startup failed before anything started, not that it is stopping started services', async () => {
    const projectDir = await project(
      ['services:', '  web:', '    command: node server.js', '    port: 4000', '    port_env: PORT', '    prod:', '      env:', '        PUBLIC_URL:', ''].join('\n'),
      { 'server.js': server },
    );
    const result = portler(projectDir, 'up', '--prod', '-d');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /service web requires PUBLIC_URL in production \(left blank in prod\.env\)/);
    assert.match(result.stderr, /startup failed before any service started/);
    assert.doesNotMatch(result.stderr, /stopping already-started services/);
  });
});

describe('up for a service that is partly running', () => {
  it('suggests restart before down', () => {
    assert.throws(
      () => ensureNoOverlap(new Set(['redis']), ['redis', 'worker'], 'portler restart worker'),
      /^Error: already running: redis\. To \(re\)start services next to what is running, use "portler restart worker"; to start over, use "portler down redis" first\.$/,
    );
    // Without an alternative (Kubernetes mode, which restart does not cover) only down is offered.
    assert.throws(() => ensureNoOverlap(new Set(['redis']), ['redis'], undefined), /^Error: already running: redis\. Use "portler down redis" first\.$/);
  });
});

describe('down for one service', () => {
  it('warns about running services that depend on it', async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4100',
        '    port_env: PORT',
        '  api:',
        '    command: node server.js',
        '    port: 4101',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    const up = portler(projectDir, 'up', '-d');
    assert.equal(up.status, 0, up.stdout + up.stderr);

    const down = portler(projectDir, 'down', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /stopped: db/);
    assert.match(down.stderr, /warning: still running and depending on what was stopped: api \(on db\)\. Stop them too, or bring it back with "portler up -d db"\./);

    // Stopping the dependent itself warns about nothing.
    const downApi = portler(projectDir, 'down', 'api');
    assert.equal(downApi.status, 0, downApi.stdout + downApi.stderr);
    assert.doesNotMatch(downApi.stderr, /warning/);
  });
});
