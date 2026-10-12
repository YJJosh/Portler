import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { buildStartEnv, selectStartService } from '../src/cli/commands/start.ts';
import { main } from '../src/cli/index.ts';
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

  it('lets a use_env file win over config but not over the platform', async () => {
    const cfg = await config(`env: {FROM_ROOT: root, SHARED: root}
services:
  api:
    command: echo
    port: 4000
    port_env: PORT
    env: {SHARED: service, PLATFORM_WINS: service}
`);
    const api = cfg.services.api!;
    const file = { SHARED: 'file', PLATFORM_WINS: 'file', FROM_FILE: 'file' };
    const env = await buildStartEnv(cfg, api, file, { PLATFORM_WINS: 'platform' });
    assert.equal(env.PLATFORM_WINS, 'platform');
    assert.equal(env.SHARED, 'file');
    assert.equal(env.FROM_ROOT, 'root');
    assert.equal(env.FROM_FILE, 'file');
    assert.equal(env.PORT, '4000');
    // File values are used as written, like in up and setup: a hostname that merely looks like a
    // reference is not resolved, and a config reference the file overrides is not resolved either.
    const literal = await buildStartEnv(cfg, api, { SHARED: 'missing.url', LITERAL: '${db.port}' }, {});
    assert.equal(literal.SHARED, 'missing.url');
    assert.equal(literal.LITERAL, '${db.port}');
    api.env.BROKEN = 'missing.url';
    await assert.rejects(buildStartEnv(cfg, api, {}, {}), /^Error: services\.api\.env\.BROKEN: cannot resolve/);
    assert.equal((await buildStartEnv(cfg, api, { BROKEN: 'from-file' }, {})).BROKEN, 'from-file');
    delete api.env.BROKEN;
  });

  it('treats toString and constructor as ordinary variable names', async () => {
    // Object.prototype members are valid variable names. A plain `in` or index lookup on the
    // platform or file map found the inherited member and silently dropped the config value.
    const cfg = await config(`env: {toString: root-string}
services:
  api:
    command: echo
    port: 4000
    env: {constructor: service-ctor}
`);
    const api = cfg.services.api!;
    const env = await buildStartEnv(cfg, api, {}, {});
    assert.equal(env.toString, 'root-string');
    assert.equal(env.constructor, 'service-ctor');
    // The usual order still holds for such a name: file over config, platform over file.
    assert.equal((await buildStartEnv(cfg, api, { constructor: 'file' }, {})).constructor, 'file');
    assert.equal((await buildStartEnv(cfg, api, { constructor: 'file' }, { constructor: 'platform' })).constructor, 'platform');
  });

  it('keeps generated values and port_env above stale platform values', async () => {
    const cfg = await config(`services:
  api:
    command: echo
    port: 4000
    port_env: [PORT, API_PORT]
  web:
    command: echo
    port: 3000
`);
    const api = cfg.services.api!;
    // A shell that still carries another Portler run's variables must not leak them in.
    const env = await buildStartEnv(cfg, api, {}, {
      PORT: '5123', API_PORT: '1', PORTLER_API_URL: 'stale', PORTLER_WEB_URL: 'stale', PORTLER_SERVICE_NAME: 'web', KEEP: 'platform',
    });
    assert.equal(env.PORT, '5123'); // the platform's PORT selects the port...
    assert.equal(env.API_PORT, '5123'); // ...and every port_env name follows that choice
    assert.match(env.PORTLER_API_URL!, /:5123$/);
    assert.match(env.PORTLER_WEB_URL!, /:3000$/);
    assert.equal(env.PORTLER_SERVICE_NAME, 'api');
    assert.equal(env.KEEP, 'platform');
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

  it('drains the process group after the shell exits, with a deadline', async () => {
    const cfg = await config('services: {api: {command: echo}}');
    // The shell exits at once; a backgrounded sleep stays in the group.
    let startedAt = Date.now();
    assert.equal(await runShell('sleep 30 & echo $! > bg.pid; exit 0', cfg.projectDir, {}, { drainMs: 300 }), 0);
    const waited = Date.now() - startedAt;
    assert.ok(waited >= 250 && waited < 5000, `waited ${waited} ms for the deadline`);
    const pid = Number((await fs.readFile(path.join(cfg.projectDir, 'bg.pid'), 'utf8')).trim());
    let gone = false;
    for (let attempt = 0; attempt < 40 && !gone; attempt += 1) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        gone = true;
      }
    }
    assert.ok(gone, 'the leftover was killed at the deadline');
    // A group that empties on its own ends the wait early.
    startedAt = Date.now();
    assert.equal(await runShell('sleep 0.2 & exit 0', cfg.projectDir, {}, { drainMs: 5000 }), 0);
    const early = Date.now() - startedAt;
    assert.ok(early >= 150 && early < 3000, `returned after ${early} ms, when the group emptied`);
    // Without drainMs the call returns with the shell, whatever it left running.
    startedAt = Date.now();
    assert.equal(await runShell('sleep 30 & echo $! > bg2.pid; exit 0', cfg.projectDir, {}), 0);
    assert.ok(Date.now() - startedAt < 1000);
    process.kill(Number((await fs.readFile(path.join(cfg.projectDir, 'bg2.pid'), 'utf8')).trim()), 'SIGKILL');
  });

  it('parses --drain-ms and scopes it to start', async () => {
    assert.equal(parseArgs(['--drain-ms', '500'], 'start').drainMs, 500);
    assert.equal(parseArgs(['--drain-ms=0'], 'start').drainMs, 0);
    assert.equal(parseArgs([], 'start').drainMs, undefined);
    assert.throws(() => parseArgs(['--drain-ms', 'soon'], 'start'), /requires a number/);
    assert.equal(parseArgs(['--drain-ms', '2147483647'], 'start').drainMs, 2147483647);
    assert.throws(() => parseArgs(['--drain-ms', '2147483648'], 'start'), /at most 2147483647/);
    // Enough digits for Number() to give Infinity, which would never reach its deadline.
    assert.throws(() => parseArgs(['--drain-ms', '9'.repeat(400)], 'start'), /at most 2147483647/);
    assert.throws(() => parseArgs([`--drain-ms=${'9'.repeat(400)}`], 'start'), /at most 2147483647/);
    await assert.rejects(main(['up', '--drain-ms', '1']), /does not apply/);
  });

  it('refuses to start without the required production values', async () => {
    const cfg = await config(`prod: {require: [DEPLOY_SECRET]}
services:
  api: {command: echo started > started, port: 4000}
`);
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.DEPLOY_SECRET;
    const refused = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'start', 'api', '--prod'], { cwd: cfg.projectDir, env, encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /service api requires DEPLOY_SECRET in production/);
    await assert.rejects(fs.access(path.join(cfg.projectDir, 'started')), 'the command did not run');
    const ok = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'start', 'api', '--prod', '--drain-ms', '0'], { cwd: cfg.projectDir, env: { ...env, DEPLOY_SECRET: 's' }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal((await fs.readFile(path.join(cfg.projectDir, 'started'), 'utf8')).trim(), 'started');
  });

  it('does not count the port it picks as the required PORT from the platform', async () => {
    const cfg = await config(`services:
  api:
    command: echo started > started
    port: 4000
    port_env: PORT
    prod: {require: [PORT]}
`);
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.PORT;
    const refused = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'start', 'api', '--prod'], { cwd: cfg.projectDir, env, encoding: 'utf8' });
    assert.equal(refused.status, 1, 'the declared port 4000 must not satisfy require: [PORT]');
    assert.match(refused.stderr, /service api requires PORT in production/);
    await assert.rejects(fs.access(path.join(cfg.projectDir, 'started')), 'the command did not run');
    const ok = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'start', 'api', '--prod', '--drain-ms', '0'], { cwd: cfg.projectDir, env: { ...env, PORT: '4567' }, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
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
