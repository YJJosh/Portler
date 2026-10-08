import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { buildStartEnv, selectStartService } from '../src/cli/commands/start.ts';
import { loadConfig } from '../src/config/loader.ts';
import { applyProduction } from '../src/config/production.ts';
import { runShell } from '../src/process/shell.ts';

const dirs: string[] = [];
async function config(text: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-start-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'portler.yml'), text);
  return loadConfig(dir);
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('start', () => {
  it('uses platform PORT and secrets ahead of prod config and resolves declared endpoints', async () => {
    const cfg = applyProduction(await config(`env: {SECRET: root}
prod:
  env: {NODE_ENV: production}
services:
  api:
    command: echo dev
    port: 4000
    port_env: [PORT, APP_PORT]
    env: {SECRET: service, DB: "postgres://db@\u0024{db.host}:\u0024{db.port}/app"}
    prod:
      command: echo prod
      env: {SECRET: prod}
  db:
    image: postgres:16
    port: 5432
    host: db.internal
`), true);
    const api = selectStartService(cfg, []);
    assert.equal(api.name, 'api');
    assert.equal(api.command, 'echo prod');
    const env = await buildStartEnv(cfg, api, { SECRET: 'file' }, { PORT: '5123', SECRET: 'platform' });
    assert.equal(env.PORT, '5123');
    assert.equal(env.APP_PORT, '5123');
    assert.equal(env.SECRET, 'platform');
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.DB, 'postgres://db@db.internal:5432/app');
    assert.equal(env.PORTLER_API_PORT, '5123');
    await assert.rejects(fs.access(path.join(cfg.projectDir, '.portler')));
  });

  it('falls back to the declared port and then a free port', async () => {
    const cfg = await config('services: {api: {command: echo, port: 4000, port_env: PORT}}');
    const api = cfg.services.api!;
    assert.equal((await buildStartEnv(cfg, api, {}, {})).PORT, '4000');
    api.port = undefined;
    const env = await buildStartEnv(cfg, api, {}, {});
    assert.ok(Number(env.PORT) > 0 && Number(env.PORT) <= 65535);
  });

  it('names unresolved variables but lets platform overrides bypass resolution', async () => {
    const cfg = await config('env: {URL: missing.url}\nservices: {api: {command: echo}}');
    const api = cfg.services.api!;
    await assert.rejects(buildStartEnv(cfg, api, {}, {}), /^Error: env\.URL: cannot resolve "missing.url"/);
    const env = await buildStartEnv(cfg, api, {}, { URL: 'https://managed.example' });
    assert.equal(env.URL, 'https://managed.example');
    api.env.URL = 'https://service.example';
    assert.equal((await buildStartEnv(cfg, api, {}, {})).URL, 'https://service.example');
    api.env.DB = 'missing.url';
    await assert.rejects(buildStartEnv(cfg, api, {}, {}), /^Error: services\.api\.env\.DB: cannot resolve/);
  });

  it('rejects references to services without declared ports', async () => {
    const cfg = await config('services: {api: {command: echo, env: {DB: db.port}}, db: {command: echo}}');
    await assert.rejects(buildStartEnv(cfg, cfg.services.api!, {}, {}), /env.DB: cannot resolve "db.port"/);
  });

  it('rejects invalid platform ports rather than silently falling back', async () => {
    const cfg = await config('services: {api: {command: echo}}');
    for (const PORT of ['', '0', '65536', '3000junk', '-1', '3.2']) {
      await assert.rejects(buildStartEnv(cfg, cfg.services.api!, {}, { PORT }), /PORT must be a port/);
    }
  });

  it('lists candidates and rejects Docker, missing commands and multiple selections', async () => {
    const cfg = await config('services: {api: {command: echo}, web: {command: echo}, db: {image: postgres:16}, empty: {port: 3000}}');
    assert.throws(() => selectStartService(cfg, []), /Candidates: api, web/);
    assert.throws(() => selectStartService(cfg, ['missing']), /unknown service "missing".*Candidates: api, web/);
    assert.throws(() => selectStartService(cfg, ['db']), /start is for local processes/);
    assert.throws(() => selectStartService(cfg, ['empty']), /has no command/);
    assert.throws(() => selectStartService(cfg, ['api', 'web']), /exactly one service/);
  });

  it('returns the shell exit code and runs in the requested cwd', async () => {
    const cfg = await config('services: {api: {command: echo}}');
    assert.equal(await runShell('pwd > cwd; exit 17', cfg.projectDir, {}), 17);
    assert.equal((await fs.readFile(path.join(cfg.projectDir, 'cwd'), 'utf8')).trim(), await fs.realpath(cfg.projectDir));
  });

  it('forwards SIGTERM to the foreground service without writing state', async () => {
    const cfg = await config(`services:
  api:
    command: exec node server.mjs
    port_env: PORT
`);
    await fs.writeFile(path.join(cfg.projectDir, 'server.mjs'), `
import fs from 'node:fs';
process.on('SIGTERM', () => { fs.writeFileSync('terminated', 'yes'); process.exit(0); });
setInterval(() => {}, 1000);
console.log('ready');
`);
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'start'], {
      cwd: cfg.projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '5123' },
    });
    try {
      const exited = once(child, 'exit');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('start did not become ready')), 5000);
        child.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      });
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0);
      assert.equal(await fs.readFile(path.join(cfg.projectDir, 'terminated'), 'utf8'), 'yes');
      await assert.rejects(fs.access(path.join(cfg.projectDir, '.portler')));
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
  });

});
