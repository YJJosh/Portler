import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandUp, StartSetChangedError, startPhase } from '../src/cli/commands/up.ts';
import { commandDown } from '../src/cli/commands/down.ts';
import { commandRestart } from '../src/cli/commands/restart.ts';
import { commandSetup } from '../src/cli/commands/setup.ts';
import { loadConfig } from '../src/config/loader.ts';
import { readPids, writePids } from '../src/process/pids.ts';
import { applyProduction } from '../src/config/production.ts';
import { buildProjectEnv, isPlainSetupStep, pruneSetupReceipts, runSetupStep, setupFingerprint } from '../src/setup/index.ts';

let dir: string;
let oldCwd: string;
let oldGlobal: string | undefined;
beforeEach(async () => {
  // Resolved path: process.cwd() resolves symlinks (macOS /var -> /private/var)
  // and receipts are keyed by the checkout path the command resolved.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-setup-')));
  oldCwd = process.cwd();
  oldGlobal = process.env.PORTLER_GLOBAL_DIR;
  process.env.PORTLER_GLOBAL_DIR = path.join(dir, 'global');
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(oldCwd);
  if (oldGlobal === undefined) delete process.env.PORTLER_GLOBAL_DIR;
  else process.env.PORTLER_GLOBAL_DIR = oldGlobal;
  await fs.rm(dir, { recursive: true, force: true });
});
async function config(text: string) {
  await fs.writeFile(path.join(dir, 'portler.yml'), text);
  return loadConfig(dir);
}
async function lines() {
  return (await fs.readFile(path.join(dir, 'steps'), 'utf8')).trim().split('\n');
}

describe('setup', () => {
  it('fingerprints one command with its cwd and mode', () => {
    const first = setupFingerprint('a', '/one', 'local:dev');
    assert.equal(first, setupFingerprint('a', '/one', 'local:dev'));
    assert.notEqual(first, setupFingerprint('b', '/one', 'local:dev'));
    assert.notEqual(first, setupFingerprint('a', '/two', 'local:dev'));
    assert.notEqual(first, setupFingerprint('a', '/one', 'local:prod'));
    assert.equal(first, setupFingerprint('a', '/one', 'local:dev', 0));
    assert.notEqual(first, setupFingerprint('a', '/one', 'local:dev', 1));
    assert.equal(first, setupFingerprint('a', '/one', 'local:dev', 0, 1));
    assert.notEqual(first, setupFingerprint('a', '/one', 'local:dev', 0, 2));
    assert.equal(isPlainSetupStep({ run: 'a' }), true);
    assert.equal(isPlainSetupStep({ run: 'a', ifMissing: 'x' }), false);
    assert.equal(isPlainSetupStep({ run: 'a', always: true }), false);
  });

  it('runs once automatically, reruns changed/forced steps, and separates modes', async () => {
    const cfg = await config('setup: echo root >> steps\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root']);
    await runSetupStep(cfg, null, {}, 'local:prod');
    await runSetupStep(cfg, null, {}, 'local:dev', true);
    cfg.setup = [{ run: 'echo changed >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root', 'root', 'root', 'changed']);
  });

  it('stops at the first failed command, keeps the receipts of the steps before it, and does not cache failure', async () => {
    const cfg = await config('setup: ["echo first >> steps", "exit 7", "echo last >> steps"]\nservices: {api: {command: echo}}');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(runSetupStep(cfg, null, {}, 'local:dev'), /setup project: command "exit 7" failed \(exit code 7\)/);
    }
    // The first step succeeded once and is not run again; the failed one and
    // the one after it have no receipt.
    assert.deepEqual(await lines(), ['first']);
    const state = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
    assert.equal(state.version, 2);
    assert.deepEqual(state.steps, { 'local:dev:project': [setupFingerprint('echo first >> steps', dir, 'local:dev')] });
    // A forced run drops the receipts before running, so the first step runs
    // again; only its fresh success is recorded, nothing for the failed step.
    await assert.rejects(runSetupStep(cfg, null, {}, 'local:dev', true), /exit code 7/);
    assert.deepEqual(await lines(), ['first', 'first']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8')).steps, {
      'local:dev:project': [setupFingerprint('echo first >> steps', dir, 'local:dev')],
    });
  });

  it('drops the receipt of a step that left the definition, and ignores version 1 receipts', async () => {
    const cfg = await config('setup: [echo a >> steps, echo b >> steps]\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    cfg.setup = [{ run: 'echo b >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['a', 'b']);
    const statePath = path.join(dir, '.portler/setup.json');
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps, { 'local:dev:project': [setupFingerprint('echo b >> steps', dir, 'local:dev')] });

    await fs.writeFile(statePath, JSON.stringify({ version: 1, project: dir, steps: { 'local:dev:project': 'old' } }));
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['a', 'b', 'b']);
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).version, 2);
  });

  it('numbers identical commands across every kind of entry, so a receipt stays with its entry', async () => {
    const cfg = await config('setup: echo same >> steps\nservices: {api: {command: echo}}');
    await fs.writeFile(path.join(dir, 'present'), '');
    cfg.setup = [{ run: 'echo same >> steps', ifMissing: 'present' }, { run: 'echo same >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['same']);
    const statePath = path.join(dir, '.portler/setup.json');
    const second = setupFingerprint('echo same >> steps', dir, 'local:dev', 1, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps, { 'local:dev:project': [second] });
    // Dropping the guard enables the first entry: it runs as occurrence 0,
    // while the second entry keeps its receipt instead of handing it over.
    cfg.setup = [{ run: 'echo same >> steps' }, { run: 'echo same >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['same', 'same']);
    const first = setupFingerprint('echo same >> steps', dir, 'local:dev', 0, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps['local:dev:project'].sort(), [first, second].sort());
  });

  it('reconciles the receipts of live owners that are not part of the run', async () => {
    const cfg = await config('services:\n  api:\n    command: echo\n    setup: echo A >> steps\n  web:\n    command: echo\n');
    const api = cfg.services.api;
    await runSetupStep(cfg, api, {}, 'local:dev');
    assert.deepEqual(await lines(), ['A']);
    // The step changes while only other owners run (`up web`), then changes
    // back: the old success must not be inherited.
    api.setup = [{ run: 'echo B >> steps' }];
    await pruneSetupReceipts(cfg, 'local:dev');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8')).steps, { 'local:dev:service:api': [] });
    api.setup = [{ run: 'echo A >> steps' }];
    await runSetupStep(cfg, api, {}, 'local:dev');
    assert.deepEqual(await lines(), ['A', 'A']);
  });

  it('re-runs every entry of a command when a duplicate of it is added or removed', async () => {
    const cfg = await config('setup: echo x >> steps\nservices: {api: {command: echo}}');
    const statePath = path.join(dir, '.portler/setup.json');
    cfg.setup = [{ run: 'echo y >> steps', always: true }, { run: 'echo x >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['y', 'x']);
    // A duplicate of x prepended: the old receipt must not go to the new first
    // entry, which would skip it and run y before the other x. The count of x
    // entries changed, so both run, in list order.
    cfg.setup = [{ run: 'echo x >> steps' }, { run: 'echo y >> steps', always: true }, { run: 'echo x >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['y', 'x', 'x', 'y', 'x']);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps['local:dev:project'], [
      setupFingerprint('echo x >> steps', dir, 'local:dev', 0, 2),
      setupFingerprint('echo x >> steps', dir, 'local:dev', 1, 2),
    ]);
    // Removing a duplicate changes the count again: the remaining x runs once more.
    cfg.setup = [{ run: 'echo y >> steps', always: true }, { run: 'echo x >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['y', 'x', 'x', 'y', 'x', 'y', 'x']);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps, { 'local:dev:project': [setupFingerprint('echo x >> steps', dir, 'local:dev')] });
  });

  it('gives identical commands in one list their own receipts', async () => {
    const cfg = await config('setup: [echo same >> steps, echo same >> steps]\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['same', 'same']);
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['same', 'same']);
    const state = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
    assert.deepEqual(state.steps['local:dev:project'], [
      setupFingerprint('echo same >> steps', dir, 'local:dev', 0, 2),
      setupFingerprint('echo same >> steps', dir, 'local:dev', 1, 2),
    ]);
    await runSetupStep(cfg, null, {}, 'local:dev', true);
    assert.deepEqual(await lines(), ['same', 'same', 'same', 'same']);
  });

  it('drops the receipts of a definition that lost all its steps, so a step added back runs again', async () => {
    const cfg = await config('setup: echo a >> steps\nservices: {api: {command: echo}}');
    const statePath = path.join(dir, '.portler/setup.json');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, { ...cfg.services.api!, setup: undefined }, {}, 'local:dev');
    assert.equal(Object.keys(JSON.parse(await fs.readFile(statePath, 'utf8')).steps).length, 1);
    cfg.setup = [];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')).steps, {});
    cfg.setup = [{ run: 'echo a >> steps' }];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['a', 'a']);

    // Without steps and without receipts nothing is written.
    await fs.rm(statePath);
    cfg.setup = undefined;
    await runSetupStep(cfg, null, {}, 'local:dev');
    await assert.rejects(fs.access(statePath));
  });

  it('if_missing steps run only while the path is absent, with or without force', async () => {
    await fs.mkdir(path.join(dir, 'app'));
    const cfg = await config(`setup:
  - run: echo install >> steps
    if_missing: node_modules
  - echo plain >> steps
services:
  app:
    cwd: app
    command: echo
    setup: [{run: 'echo generate >> ../steps', if_missing: generated/client.ts}]
`);
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, cfg.services.app!, {}, 'local:dev');
    assert.deepEqual(await lines(), ['install', 'plain', 'generate']);

    // Once the paths exist the guarded steps are skipped; the plain step has
    // its receipt. Force reruns the plain step but not the guarded ones.
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.mkdir(path.join(dir, 'app', 'generated'));
    await fs.writeFile(path.join(dir, 'app', 'generated', 'client.ts'), '');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, cfg.services.app!, {}, 'local:dev');
    assert.deepEqual(await lines(), ['install', 'plain', 'generate']);
    await runSetupStep(cfg, null, {}, 'local:dev', true);
    await runSetupStep(cfg, cfg.services.app!, {}, 'local:dev', true);
    assert.deepEqual(await lines(), ['install', 'plain', 'generate', 'plain']);

    // Deleting what a guarded step produced makes it run again; a file at the
    // path counts as much as a directory.
    await fs.rm(path.join(dir, 'node_modules'), { recursive: true });
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['install', 'plain', 'generate', 'plain', 'install']);
    await fs.writeFile(path.join(dir, 'node_modules'), '');
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['install', 'plain', 'generate', 'plain', 'install']);
    // Guarded steps never get a receipt: the service, which has nothing else,
    // has no entry at all.
    const state = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
    assert.deepEqual(state.steps, { 'local:dev:project': [setupFingerprint('echo plain >> steps', dir, 'local:dev')] });
  });

  it('always steps run on every up and setup, next to receipt-tracked ones', async () => {
    const cfg = await config(`setup:
  - echo once >> steps
  - {run: echo every >> steps, always: true}
services: {api: {command: echo}}
`);
    for (let attempt = 0; attempt < 3; attempt += 1) await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['once', 'every', 'every', 'every']);
    const state = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
    assert.deepEqual(state.steps, { 'local:dev:project': [setupFingerprint('echo once >> steps', dir, 'local:dev')] });
  });

  it('invalidates a prior receipt when a forced run fails', async () => {
    const cfg = await config('setup: test ! -f fail\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await fs.writeFile(path.join(dir, 'fail'), '');
    await assert.rejects(runSetupStep(cfg, null, {}, 'local:dev', true), /exit code 1/);
    await assert.rejects(runSetupStep(cfg, null, {}, 'local:dev'), /exit code 1/);
  });

  it('runs project first then selected dependencies, uses cwd and resolved service env, and starts nothing', async () => {
    await fs.mkdir(path.join(dir, 'app'));
    await fs.writeFile(path.join(dir, '.env'), 'FROM_FILE=file\n');
    await config(`use_env: .env
env: {ROOT: root}
setup: echo "$ROOT-$FROM_FILE" >> steps
services:
  app:
    cwd: app
    setup: echo "$API_URL-$PORT-$FROM_FILE" >> ../steps
    command: touch should-not-start
    port: 3000
    port_env: PORT
    env: {API_URL: api.url}
    depends_on: api
  api:
    setup: echo api >> steps
    command: touch should-not-start
    port: 4000
  ignored:
    setup: echo ignored >> steps
`);
    assert.equal(await commandSetup(parseArgs(['app'], 'setup')), 0);
    const result = await lines();
    assert.equal(result[0], 'root-file');
    assert.equal(result[1], 'api');
    assert.match(result[2]!, /^http:\/\/localhost:\d+-\d+-file$/);
    assert.equal(result.length, 3);
    await assert.rejects(fs.access(path.join(dir, '.portler/pids.json')));
    await assert.rejects(fs.access(path.join(dir, 'should-not-start')));
    await commandSetup(parseArgs(['app'], 'setup'));
    assert.equal((await lines()).length, 6, 'explicit setup always reruns');
  });

  it('merges the project environment without service env', async () => {
    const cfg = await config('env: {KEY: root}\nservices: {api: {env: {KEY: service}}}');
    const env = buildProjectEnv(cfg, { KEY: 'file', ONLY_FILE: 'value' }, {});
    assert.equal(env.KEY, 'root');
    assert.equal(env.ONLY_FILE, 'value');
    // Production: the deployment wins over config, and the process env over the file.
    assert.equal(buildProjectEnv(applyProduction(cfg, true), { KEY: 'file' }, {}).KEY, 'file');
    const saved = process.env.KEY;
    process.env.KEY = 'shell';
    try {
      assert.equal(buildProjectEnv(applyProduction(cfg, true), { KEY: 'file' }, {}).KEY, 'shell');
      assert.equal(buildProjectEnv(cfg, { KEY: 'file' }, {}).KEY, 'root');
    } finally {
      if (saved === undefined) delete process.env.KEY;
      else process.env.KEY = saved;
    }
  });

  it('does not resolve a project env value the deployment overrides in production', async () => {
    const cfg = await config('env: {BAD: missing.url}\nservices: {api: {command: echo}}');
    assert.throws(() => buildProjectEnv(cfg, { BAD: 'file' }, {}), /cannot resolve|no assigned port/);
    assert.throws(() => buildProjectEnv(applyProduction(cfg, true), {}, {}), /cannot resolve|no assigned port/);
    assert.equal(buildProjectEnv(applyProduction(cfg, true), { BAD: 'file' }, {}).BAD, 'file');
  });

  it('does not reuse success receipts copied from another checkout', async () => {
    const cfg = await config('setup: echo root >> steps\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    const statePath = path.join(dir, '.portler/setup.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    state.project = '/another/checkout';
    await fs.writeFile(statePath, JSON.stringify(state));
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root', 'root']);
  });

  it('prunes the receipts of owners that left the config, per mode', async () => {
    const cfg = await config('setup: echo root >> steps\nservices: {api: {command: echo, setup: echo api >> steps}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, cfg.services.api!, {}, 'local:dev');
    await runSetupStep(cfg, cfg.services.api!, {}, 'local:prod');
    const statePath = path.join(dir, '.portler/setup.json');
    const keys = async () => Object.keys(JSON.parse(await fs.readFile(statePath, 'utf8')).steps).sort();
    assert.deepEqual(await keys(), ['local:dev:project', 'local:dev:service:api', 'local:prod:service:api']);

    // api left the config: explicit setup reconciles the dev receipts before it
    // runs what is left; the prod receipt belongs to another mode and stays.
    await config('setup: echo root >> steps\nservices: {web: {command: echo}}');
    await commandSetup(parseArgs([], 'setup'));
    assert.deepEqual(await keys(), ['local:dev:project', 'local:prod:service:api']);

    // Back with the same step, api runs again instead of looking done.
    await runSetupStep(cfg, cfg.services.api!, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root', 'api', 'api', 'root', 'api']);

    // An owner that merely lost its steps is pruned too; nothing to prune writes nothing.
    const bare = await config('services: {web: {command: echo}}');
    await pruneSetupReceipts(bare, 'local:dev');
    assert.deepEqual(await keys(), ['local:prod:service:api']);
    await fs.rm(statePath);
    await pruneSetupReceipts(bare, 'local:dev');
    await assert.rejects(fs.access(statePath));
  });

  it('a service removed between up cycles runs its setup again when it comes back', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const api = '  api:\n    command: node server.mjs\n    setup: echo api >> steps\n    port: 4000\n    port_env: PORT\n';
    const web = '  web:\n    command: node server.mjs\n    port: 3000\n    port_env: PORT\n';
    const statePath = path.join(dir, '.portler/setup.json');
    const keys = async () => Object.keys(JSON.parse(await fs.readFile(statePath, 'utf8')).steps);
    try {
      await config(`services:\n${api}${web}`);
      await commandUp(parseArgs(['api', '-d'], 'up'));
      assert.deepEqual(await lines(), ['api']);
      assert.deepEqual(await keys(), ['local:dev:service:api']);
      await commandDown(parseArgs([], 'down'));

      await config(`services:\n${web}`);
      await commandUp(parseArgs(['web', '-d'], 'up'));
      assert.deepEqual(await keys(), [], 'the removed service loses its receipt on the next up');
      await commandDown(parseArgs([], 'down'));

      await config(`services:\n${api}${web}`);
      await commandUp(parseArgs(['api', '-d'], 'up'));
      assert.deepEqual(await lines(), ['api', 'api']);
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('reconciles receipts under --no-setup, so a step removed during such a run loses its receipt', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const app = '  app:\n    command: node server.mjs\n    port: 3000\n    port_env: PORT\n';
    const statePath = path.join(dir, '.portler/setup.json');
    const receipts = async () => JSON.parse(await fs.readFile(statePath, 'utf8')).steps['local:dev:project'] ?? [];
    try {
      await config(`setup: echo root >> steps\nservices:\n${app}`);
      await commandUp(parseArgs(['app', '-d'], 'up'));
      assert.deepEqual(await lines(), ['root']);
      assert.equal((await receipts()).length, 1);
      await commandDown(parseArgs([], 'down'));

      await config(`services:\n${app}`);
      await commandUp(parseArgs(['app', '-d', '--no-setup'], 'up'));
      assert.deepEqual(await lines(), ['root'], 'no setup command ran');
      assert.deepEqual(await receipts(), [], 'the removed step lost its receipt anyway');
      await commandDown(parseArgs([], 'down'));

      await config(`setup: echo root >> steps\nservices:\n${app}`);
      await commandUp(parseArgs(['app', '-d'], 'up'));
      assert.deepEqual(await lines(), ['root', 'root'], 'the step added back runs again');
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a plain restart keeps a production stack in production mode', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`services:
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
`);
    try {
      await commandUp(parseArgs(['api', '-d', '--prod'], 'up'));
      assert.deepEqual(await lines(), ['prod']);
      assert.equal((await readPids(dir))?.services.api?.prod, true, 'the run mode is recorded');

      // A routine restart replays the recorded launch: the stack stays in production.
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'prod']);
      assert.equal((await readPids(dir))?.services.api?.prod, true, 'replayed and recorded again');
      assert.equal((await readPids(dir))?.services.api?.runMode, 'local', 'the run mode is recorded');

      await commandRestart(parseArgs(['api', '--prod'], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'prod', 'prod']);
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('restart --prod checks prod.require before stopping anything', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`services:
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
      require: [DEPLOY_SECRET]
`);
    const oldSecret = process.env.DEPLOY_SECRET;
    process.env.DEPLOY_SECRET = 's';
    try {
      await commandUp(parseArgs(['api', '-d', '--prod'], 'up'));
      const pid = (await readPids(dir))?.services.api?.pid;
      assert.ok(pid);
      delete process.env.DEPLOY_SECRET;
      await assert.rejects(commandRestart(parseArgs(['api', '--prod'], 'restart')), /service api requires DEPLOY_SECRET in production/);
      assert.equal((await readPids(dir))?.services.api?.pid, pid, 'api was not stopped');
      assert.doesNotThrow(() => process.kill(pid, 0), 'api is still running');
      assert.deepEqual(await lines(), ['prod'], 'nothing was restarted');
    } finally {
      if (oldSecret === undefined) delete process.env.DEPLOY_SECRET;
      else process.env.DEPLOY_SECRET = oldSecret;
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a restart that replays --prod checks prod.require first and leaves out what prod.services does', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    // db is the deployment's under --prod; its own requirement is never supplied here.
    await config(`prod:
  services: [api]
services:
  db:
    command: node server.mjs
    port: 4001
    port_env: PORT
    env: {MODE: dev}
    prod:
      require: [DB_HOST_ONLY]
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    depends_on: [db]
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
      require: [DEPLOY_SECRET]
`);
    const oldSecret = process.env.DEPLOY_SECRET;
    const oldDbHost = process.env.DB_HOST_ONLY;
    process.env.DEPLOY_SECRET = 's';
    delete process.env.DB_HOST_ONLY;
    try {
      await commandUp(parseArgs(['api', '-d', '--prod'], 'up'));
      const pid = (await readPids(dir))?.services.api?.pid;
      assert.ok(pid);
      assert.deepEqual(await lines(), ['prod']);

      // No --prod on the command line: the replayed one still checks prod.require
      // while api is up.
      delete process.env.DEPLOY_SECRET;
      await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /service api requires DEPLOY_SECRET in production/);
      assert.equal((await readPids(dir))?.services.api?.pid, pid, 'api was not stopped');
      assert.doesNotThrow(() => process.kill(pid, 0), 'api is still running');
      assert.deepEqual(await lines(), ['prod'], 'nothing was restarted');

      // And it narrows to prod.services like a typed --prod: db is neither checked nor started.
      process.env.DEPLOY_SECRET = 's';
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'prod']);
      const after = await readPids(dir);
      assert.equal(after?.services.api?.prod, true, 'replayed and recorded again');
      assert.equal(after?.services.db, undefined, 'db stays the deployment\'s');

      // Without names too: every service in the config would include db, which the
      // replayed --prod leaves to the deployment.
      await commandRestart(parseArgs([], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'prod', 'prod']);
      assert.deepEqual(Object.keys((await readPids(dir))?.services ?? {}), ['api']);
    } finally {
      if (oldSecret === undefined) delete process.env.DEPLOY_SECRET;
      else process.env.DEPLOY_SECRET = oldSecret;
      if (oldDbHost === undefined) delete process.env.DB_HOST_ONLY;
      else process.env.DB_HOST_ONLY = oldDbHost;
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a dev copy of a service prod.services leaves out does not stop a plain restart replaying --prod', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    // Under --prod, db is the deployment's; a development db happens to run next to api.
    await config(`prod:
  services: [api]
services:
  db:
    command: node server.mjs
    port: 4001
    port_env: PORT
    env: {MODE: dev}
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    depends_on: [db]
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
`);
    try {
      await commandUp(parseArgs(['db', '-d'], 'up'));
      await commandUp(parseArgs(['api', '-d', '--prod'], 'up'));
      assert.deepEqual(await lines(), ['dev', 'prod']);
      const dbPid = (await readPids(dir))?.services.db?.pid;
      assert.ok(dbPid);

      // The same as `restart api --prod`: db has no say in the replayed mode.
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'prod', 'prod']);
      const after = await readPids(dir);
      assert.equal(after?.services.api?.prod, true);
      assert.equal(after?.services.db?.pid, dbPid, 'db was left alone');
      assert.notEqual(after?.services.db?.prod, true);

      // db itself still restarts as what it is.
      await commandRestart(parseArgs(['db'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'prod', 'prod', 'dev']);

      // Restarting everything takes in both, and there is no one mode for that.
      const before = await readPids(dir);
      await assert.rejects(commandRestart(parseArgs([], 'restart')), /no one mode to replay/);
      assert.deepEqual(await readPids(dir), before, 'nothing was stopped');
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a restart replaying --prod plans on prod.services as they are now', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const services = `services:
  db:
    command: node server.mjs
    port: 4001
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
  web:
    command: node server.mjs
    port: 4002
    port_env: PORT
    depends_on: [db]
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
`;
    await config(`prod:\n  services: [db, api, web]\n${services}`);
    try {
      await commandUp(parseArgs(['api', 'web', '-d', '--prod'], 'up'));
      assert.deepEqual(await lines(), ['prod', 'prod', 'prod']);

      // api has since been dropped from prod.services: its record still says --prod, and a
      // plain restart is refused the way `restart api --prod` is, with api still running.
      await config(`prod:\n  services: [db, web]\n${services}`);
      const before = await readPids(dir);
      await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /service "api" is not in prod\.services/);
      assert.deepEqual(await readPids(dir), before, 'nothing was stopped');

      // web is not running and db, which it depends on, has died and been dropped too: the
      // only record the restart sees is db's, which replays --prod, and web starts in
      // production without db (the deployment's under --prod).
      await commandDown(parseArgs(['web'], 'down'));
      const dbPid = before?.services.db?.pid;
      assert.ok(dbPid);
      process.kill(-dbPid, 'SIGKILL');
      for (let i = 0; i < 100; i++) {
        try { process.kill(dbPid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await config(`prod:\n  services: [web]\n${services}`);
      await commandRestart(parseArgs(['web'], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'prod', 'prod', 'prod']);
      assert.equal((await readPids(dir))?.services.web?.prod, true);
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('restart --prod refuses to put a production service on top of development dependencies', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`services:
  db:
    command: node server.mjs
    port: 4001
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    depends_on: [db]
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
`);
    try {
      await commandUp(parseArgs(['api', '-d'], 'up'));
      assert.deepEqual(await lines(), ['dev', 'dev']);
      assert.equal((await readPids(dir))?.services.db?.prod, false, 'development is recorded explicitly');

      // restart skips the running db, so db would stay in development while api
      // came back in production: refused before anything is stopped.
      await assert.rejects(commandRestart(parseArgs(['api', '--prod'], 'restart')), /db is running in development mode/);
      assert.deepEqual(await lines(), ['dev', 'dev'], 'nothing was restarted');

      // Same mode: api restarts and db is left running.
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'dev', 'dev']);

      // Restarting everything may switch the whole stack: nothing is left behind in the other mode.
      await commandRestart(parseArgs(['--prod'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'dev', 'dev', 'prod', 'prod']);
      assert.equal((await readPids(dir))?.services.db?.prod, true);
      assert.equal((await readPids(dir))?.services.api?.prod, true);
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a restart replays --no-setup, which a server without the toolchain needs', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`setup: exit 17
services:
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
    env: {MODE: dev}
`);
    try {
      await commandUp(parseArgs(['api', '-d', '--no-setup'], 'up'));
      assert.deepEqual(await lines(), ['dev']);
      assert.equal((await readPids(dir))?.services.api?.setup, false, '--no-setup is recorded');
      // Without the flag, restart replays --no-setup.
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'dev']);
      assert.equal((await readPids(dir))?.services.api?.setup, false, 'and records it again');
      await commandRestart(parseArgs(['api', '--no-setup'], 'restart'));
      assert.deepEqual(await lines(), ['dev', 'dev', 'dev']);
      // --setup overrides the recorded policy: the failing step runs, after api was stopped.
      await assert.rejects(commandRestart(parseArgs(['api', '--setup'], 'restart')), /failed \(exit code 17\)/);
    } finally {
      await commandDown(parseArgs([], 'down')).catch(() => {});
    }
  });

  it('a dependency that exits while restart stops its root comes back with its own recorded launch', async () => {
    // db records its pid; api, on SIGTERM, kills db and lingers a moment, so db is gone by the
    // time the stop returns: a dependency that exits on its own between the plan and the start.
    await fs.writeFile(path.join(dir, 'db.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.writeFileSync('db.pid', String(process.pid));
fs.appendFileSync('steps', 'db\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(dir, 'api.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', 'api\\n');
process.on('SIGTERM', () => {
  try { process.kill(Number(fs.readFileSync('db.pid', 'utf8')), 'SIGKILL'); } catch {}
  setTimeout(() => process.exit(0), 300);
});
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`setup: node -e "require('fs').appendFileSync('setups', 'x')"
services:
  db:
    command: node db.mjs
    port: 4000
    port_env: PORT
  api:
    command: node api.mjs
    port: 4001
    port_env: PORT
    depends_on: [db]
`);
    const setups = async () => fs.readFile(path.join(dir, 'setups'), 'utf8').catch(() => '');
    try {
      await commandUp(parseArgs(['-d'], 'up'));
      await commandRestart(parseArgs(['db', '--no-setup'], 'restart'));
      assert.equal((await readPids(dir))?.services.db?.setup, false, 'db now records --no-setup');
      assert.deepEqual(await lines(), ['db', 'api', 'db']);
      assert.equal(await setups(), 'x');

      // api ran its setup and db skipped it. db dies during api's stop and would come back
      // too, so its record takes part in the setup choice: the two disagree, and restart says
      // so instead of starting db with api's setup steps.
      await assert.rejects(
        commandRestart(parseArgs(['api'], 'restart')),
        /db exited on its own while restart was stopping api, and starting again is refused: db was started with --no-setup and api with its setup steps.*Nothing was started, so api is stopped/s,
      );
      assert.deepEqual(await lines(), ['db', 'api', 'db'], 'nothing was started');
      assert.equal(await setups(), 'x', 'no setup ran');

      // With both recorded --no-setup, db comes back with api, both without setup.
      await commandRestart(parseArgs(['--no-setup'], 'restart'));
      assert.deepEqual(await lines(), ['db', 'api', 'db', 'db', 'api']);
      const dbBefore = (await readPids(dir))?.services.db?.pid;
      await commandRestart(parseArgs(['api'], 'restart'));
      assert.deepEqual(await lines(), ['db', 'api', 'db', 'db', 'api', 'db', 'api']);
      const after = await readPids(dir);
      assert.notEqual(after?.services.db?.pid, dbBefore, 'db was started again');
      assert.equal(after?.services.db?.setup, false);
      assert.equal(after?.services.api?.setup, false);
      assert.equal(await setups(), 'x', 'still no setup ran');
    } finally {
      await commandDown(parseArgs([], 'down')).catch(() => {});
    }
  });

  it('startPhase refuses to start anything its caller did not plan for', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', 'started\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const loaded = await config(`services:
  db:
    command: node server.mjs
    port: 4000
    port_env: PORT
  api:
    command: node server.mjs
    port: 4001
    port_env: PORT
    depends_on: [db]
`);
    // The caller planned api alone, but db is not running, so starting api would start db too.
    await assert.rejects(
      startPhase(loaded, 'local', ['api'], { detach: true, skipRunning: true, expectStart: ['api'] }),
      (error: unknown) => error instanceof StartSetChangedError && /planned api, found db, api/.test(error.message),
    );
    assert.equal((await readPids(dir))?.services.db, undefined, 'nothing was started');
    await assert.rejects(fs.access(path.join(dir, 'steps')), 'no service ran');
  });

  it('startPhase leaves alone a dependency whose container runs on after its docker run shell', async () => {
    const loaded = await config(`services:
  db:
    image: postgres:16-alpine
    port: 4000
    port_env: PORT
  api:
    image: postgres:16-alpine
    port: 4001
    port_env: PORT
    depends_on: [db]
`);
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    const dbEntry = { pid: exited.pid!, command: 'docker run db', cwd: loaded.projectDir, startedAt: new Date().toISOString(), dockerContainer: 'c-db', runMode: 'docker' as const };
    await writePids(loaded.projectDir, { version: 1, project: loaded.projectDir, startedAt: new Date().toISOString(), services: { db: dbEntry } });

    // A docker on PATH that reports c-db running under this project's label: the shell
    // `docker run db` ran in is gone, the container is not.
    const bin = path.join(dir, 'fake-bin');
    await fs.mkdir(bin, { recursive: true });
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': loaded.projectDir }, running: true });
    await fs.writeFile(
      path.join(bin, 'docker'),
      ['#!/bin/sh', 'eval last=\\${$#}', `[ "$last" = c-db ] && { printf '%s\\n' '${inspected}'; exit 0; }`, 'echo "Error: No such object: $last" >&2; exit 1', ''].join('\n'),
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      // Planning nothing makes startPhase report what it would start, before it starts anything.
      await assert.rejects(
        startPhase(loaded, 'docker', ['api'], { detach: true, skipRunning: true, expectStart: [] }),
        (error: unknown) => error instanceof StartSetChangedError && /planned none, found api\)/.test(error.message),
      );
    } finally {
      process.env.PATH = savedPath;
    }
    assert.deepEqual((await readPids(loaded.projectDir))?.services.db, dbEntry, 'db was not touched');
  });

  it('startPhase does not call a kept dependency dead while its container runs on', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const loaded = await config(`services:
  db:
    image: postgres:16-alpine
    port: 4000
    port_env: PORT
  api:
    command: node server.mjs
    port: 4001
    port_env: PORT
    depends_on: [db]
`);
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    const dbEntry = { pid: exited.pid!, command: 'docker run db', cwd: loaded.projectDir, startedAt: new Date().toISOString(), dockerContainer: 'c-db', runMode: 'docker' as const };
    await writePids(loaded.projectDir, { version: 1, project: loaded.projectDir, startedAt: new Date().toISOString(), services: { db: dbEntry } });

    const bin = path.join(dir, 'fake-bin');
    await fs.mkdir(bin, { recursive: true });
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': loaded.projectDir }, running: true });
    await fs.writeFile(
      path.join(bin, 'docker'),
      ['#!/bin/sh', 'eval last=\\${$#}', `[ "$last" = c-db ] && { printf '%s\\n' '${inspected}'; exit 0; }`, 'echo "Error: No such object: $last" >&2; exit 1', ''].join('\n'),
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      // db is kept (its container runs), api starts; the check that a kept dependency is
      // still alive after api's level must ask about the container, not the gone shell.
      await startPhase(loaded, 'local', ['api'], { detach: true, skipRunning: true, expectStart: ['api'] });
      const after = await readPids(loaded.projectDir);
      assert.deepEqual(after?.services.db, dbEntry, 'db was not touched');
      assert.ok(after?.services.api, 'api was started');
    } finally {
      process.env.PATH = savedPath;
      const apiPid = (await readPids(loaded.projectDir))?.services.api?.pid;
      if (apiPid !== undefined) {
        try {
          process.kill(-apiPid, 'SIGKILL');
        } catch {}
      }
    }
  });

  it('startPhase notices a started service that exits while a kept container is still being inspected', async () => {
    // api answers the readiness connection, then exits 200 ms later: while the
    // fake docker below is still answering about db.
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import http from 'node:http';
const server = http.createServer((req, res) => res.end('ok'));
server.once('connection', () => setTimeout(() => process.exit(1), 200));
server.listen(Number(process.env.PORT), '127.0.0.1');
`);
    const loaded = await config(`services:
  db:
    image: postgres:16-alpine
    port: 4000
    port_env: PORT
  api:
    command: node server.mjs
    port: 4001
    port_env: PORT
    depends_on: [db]
`);
    const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(exited, 'exit');
    const dbEntry = { pid: exited.pid!, command: 'docker run db', cwd: loaded.projectDir, startedAt: new Date().toISOString(), dockerContainer: 'c-db', runMode: 'docker' as const };
    await writePids(loaded.projectDir, { version: 1, project: loaded.projectDir, startedAt: new Date().toISOString(), services: { db: dbEntry } });

    // A docker that takes a second to report c-db running.
    const bin = path.join(dir, 'fake-bin');
    await fs.mkdir(bin, { recursive: true });
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': loaded.projectDir }, running: true });
    await fs.writeFile(
      path.join(bin, 'docker'),
      ['#!/bin/sh', 'eval last=\\${$#}', `[ "$last" = c-db ] && { sleep 1; printf '%s\\n' '${inspected}'; exit 0; }`, 'echo "Error: No such object: $last" >&2; exit 1', ''].join('\n'),
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
    try {
      // api's level is the last one and there is no proxy, so the check after it is
      // the only one that can see api die.
      await assert.rejects(
        startPhase(loaded, 'local', ['api'], { detach: true, skipRunning: true, expectStart: ['api'] }),
        /service api exited while the stack was still starting/,
      );
      assert.deepEqual((await readPids(loaded.projectDir))?.services.db, dbEntry, 'db was not touched');
    } finally {
      process.env.PATH = savedPath;
      const apiPid = (await readPids(loaded.projectDir))?.services.api?.pid;
      if (apiPid !== undefined) {
        try {
          process.kill(-apiPid, 'SIGKILL');
        } catch {}
      }
    }
  });

  it('a restart without names replays the mode of recorded services that left the config', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import fs from 'node:fs';
import http from 'node:http';
fs.appendFileSync('steps', (process.env.MODE ?? 'unset') + '\\n');
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await config(`services:
  old:
    command: node server.mjs
    port: 4000
    port_env: PORT
    env: {MODE: dev}
    prod:
      env: {MODE: prod}
`);
    try {
      await commandUp(parseArgs(['old', '-d', '--prod'], 'up'));
      assert.deepEqual(await lines(), ['prod']);
      await config(`services:
  new:
    command: node server.mjs
    port: 4001
    port_env: PORT
    env: {MODE: dev}
`);
      // old is no longer in the config but is recorded in production mode: the stack was
      // production, so the restart stops old and starts the current config in production.
      await commandRestart(parseArgs([], 'restart'));
      assert.deepEqual(await lines(), ['prod', 'dev'], 'new has no prod env, so its MODE stays dev');
      assert.equal((await readPids(dir))?.services.old, undefined, 'old is gone');
      assert.equal((await readPids(dir))?.services.new?.prod, true, 'new was started in production mode');
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

  it('a cancelled setup step is not recorded and stops the run, even when the command exits 0', async () => {
    await fs.writeFile(path.join(dir, 'step.mjs'), `
import fs from 'node:fs';
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { fs.writeFileSync('handled', signal); process.exit(0); });
setInterval(() => {}, 1000);
fs.writeFileSync('ready', 'yes');
`);
    await config(`setup:
  - exec node step.mjs
  - echo ran > later
services: {api: {command: echo}}
`);
    const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      await fs.rm(path.join(dir, 'ready'), { force: true });
      const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'setup'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      const exited = once(child, 'exit');
      try {
        for (let i = 0; i < 100 && !(await fs.access(path.join(dir, 'ready')).then(() => true, () => false)); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        child.kill(signal);
        const [code] = await exited;
        assert.notEqual(code, 0, `exit code after ${signal}: ${output}`);
        assert.match(output, /interrupted by SIG(TERM|INT)/);
        assert.equal(await fs.readFile(path.join(dir, 'handled'), 'utf8'), signal, 'the step received the forwarded signal and exited 0');
        await assert.rejects(fs.access(path.join(dir, 'later')), 'the next step did not run');
        const receipts = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
        assert.deepEqual(receipts.steps['local:dev:project'] ?? [], [], 'the interrupted step has no receipt');
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
  });

  it('a watch step runs again when one of its files changes, appears or disappears', async () => {
    await fs.writeFile(path.join(dir, 'lock'), 'v1');
    const cfg = await config(`setup: [{run: "echo install >> steps", watch: [lock]}]
services: {app: {command: echo}}
`);
    const run = () => runSetupStep(cfg, null, {}, 'local:dev');
    await run();
    await run();
    assert.deepEqual(await lines(), ['install'], 'unchanged file: the receipt holds');
    await fs.writeFile(path.join(dir, 'lock'), 'v2');
    await run();
    await run();
    assert.deepEqual(await lines(), ['install', 'install'], 'a changed file runs the step once');
    await fs.rm(path.join(dir, 'lock'));
    await run();
    assert.deepEqual(await lines(), ['install', 'install', 'install'], 'a missing file is a state of its own');
    await fs.writeFile(path.join(dir, 'lock'), 'v2');
    await run();
    assert.equal((await lines()).length, 4, 'and so is its return');
  });

  it('a watched file that appears with any content runs the step, even content that looked like absence', async () => {
    const cfg = await config(`setup: [{run: "echo install >> steps", watch: [lock, other]}]
services: {app: {command: echo}}
`);
    const run = () => runSetupStep(cfg, null, {}, 'local:dev');
    await run();
    assert.deepEqual(await lines(), ['install'], 'both files absent: the step runs once');
    await fs.writeFile(path.join(dir, 'lock'), '<missing>');
    await run();
    assert.deepEqual(await lines(), ['install', 'install'], 'a file appearing runs the step, whatever it holds');
    await fs.rm(path.join(dir, 'lock'));
    await run();
    assert.equal((await lines()).length, 3, 'and so does its disappearing');
    await fs.writeFile(path.join(dir, 'lock'), '<missing>\0other\0');
    await run();
    assert.equal((await lines()).length, 4, 'content cannot pass for the next file\'s entry either');
  });

  it('a watched path that exists but cannot be read is an error, not absence', async () => {
    const cfg = await config(`setup: [{run: "echo install >> steps", watch: [lock]}]
services: {app: {command: echo}}
`);
    const run = () => runSetupStep(cfg, null, {}, 'local:dev');
    await run();
    assert.deepEqual(await lines(), ['install'], 'the file is absent: the step runs once');
    // A directory cannot be read as a file on any platform (EISDIR), like an unreadable file.
    await fs.mkdir(path.join(dir, 'lock'));
    await assert.rejects(run(), /watch file "lock" cannot be read/);
    assert.deepEqual(await lines(), ['install'], 'neither skipped as if absent nor run');
  });

  it('a watch step reads its files when it is reached and records them as they are after it succeeds', async () => {
    await fs.writeFile(path.join(dir, 'source'), 'a');
    const cfg = await config(`setup:
  - {run: "cp source generated", always: true}
  - {run: "echo use >> steps", watch: [generated]}
  - {run: "echo own >> steps; echo x >> counter", watch: [counter]}
services: {app: {command: echo}}
`);
    const run = () => runSetupStep(cfg, null, {}, 'local:dev');
    await run();
    assert.deepEqual(await lines(), ['use', 'own']);
    await run();
    assert.deepEqual(await lines(), ['use', 'own'], 'a step that rewrote its own watched file does not run again for that');
    await fs.writeFile(path.join(dir, 'source'), 'b');
    await run();
    assert.deepEqual(await lines(), ['use', 'own', 'use'], 'an earlier step rewrote the watched file in this run, so the step runs');
    await run();
    assert.equal((await lines()).length, 3, 'and its receipt holds for what it ran against');
  });

  it('a watch step that fails loses its old receipt, even when the file goes back', async () => {
    await fs.writeFile(path.join(dir, 'lock'), 'v1');
    await fs.writeFile(path.join(dir, 'fail'), 'no');
    const cfg = await config(`setup: [{run: "echo install >> steps; grep -q no fail", watch: [lock]}]
services: {app: {command: echo}}
`);
    const run = () => runSetupStep(cfg, null, {}, 'local:dev');
    await run();
    await fs.writeFile(path.join(dir, 'lock'), 'v2');
    await fs.writeFile(path.join(dir, 'fail'), 'yes');
    await assert.rejects(run(), /failed/);
    await fs.writeFile(path.join(dir, 'lock'), 'v1');
    await fs.writeFile(path.join(dir, 'fail'), 'no');
    await run();
    assert.deepEqual(await lines(), ['install', 'install', 'install'], 'the half-done run is not covered by the v1 receipt');
  });

  it('setup skips a missing use_env file in development, like --prod does', async () => {
    await config(`use_env: .env
setup: echo ok >> steps
services: {app: {command: echo}}
`);
    assert.equal(await commandSetup(parseArgs([], 'setup')), 0);
    assert.deepEqual(await lines(), ['ok']);
  });

  it('prod.require fails up and setup before anything runs, naming the missing keys', async () => {
    await config(`prod: {require: [DEPLOY_SECRET]}
setup: echo ran >> steps
services:
  app:
    command: node -e "setInterval(() => {}, 1000)"
    port: 3000
    prod: {require: [APP_TOKEN]}
`);
    delete process.env.DEPLOY_SECRET;
    delete process.env.APP_TOKEN;
    try {
      await assert.rejects(commandSetup(parseArgs(['--prod'], 'setup')), /the project requires DEPLOY_SECRET in production/);
      await assert.rejects(commandUp(parseArgs(['-d', '--prod'], 'up')), /the project requires DEPLOY_SECRET in production/);
      await assert.rejects(fs.access(path.join(dir, 'steps')));
      assert.equal(await readPids(dir), null, 'nothing was started');
      process.env.DEPLOY_SECRET = 's';
      await assert.rejects(commandSetup(parseArgs(['--prod'], 'setup')), /service app requires APP_TOKEN in production/);
      process.env.APP_TOKEN = 't';
      assert.equal(await commandSetup(parseArgs(['--prod'], 'setup')), 0);
      assert.deepEqual(await lines(), ['ran']);
    } finally {
      delete process.env.DEPLOY_SECRET;
      delete process.env.APP_TOKEN;
    }
  });

  it('auto-setup waits for dependencies and respects force/skip across up cycles', async () => {
    await fs.writeFile(path.join(dir, 'server.mjs'), `
import http from 'node:http';
http.createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(dir, 'ready.mjs'), `
import fs from 'node:fs';
const response = await fetch(process.env.API_URL);
if (!response.ok) process.exit(1);
fs.appendFileSync('steps', 'app-ready\\n');
`);
    await config(`setup: echo root >> steps
services:
  app:
    command: node server.mjs
    setup: node ready.mjs
    port: 3000
    port_env: PORT
    depends_on: api
    env: {API_URL: api.url}
  api:
    command: node server.mjs
    port: 4000
    port_env: PORT
`);
    try {
      await commandUp(parseArgs(['app', '-d'], 'up'));
      assert.deepEqual(await lines(), ['root', 'app-ready']);
      await assert.rejects(commandUp(parseArgs(['app', '-d', '--prod'], 'up')), /already running/);
      await commandDown(parseArgs([], 'down'));
      await commandUp(parseArgs(['app', '-d'], 'up'));
      assert.deepEqual(await lines(), ['root', 'app-ready']);
      await commandDown(parseArgs([], 'down'));
      await commandUp(parseArgs(['app', '-d', '--setup'], 'up'));
      assert.deepEqual(await lines(), ['root', 'app-ready', 'root', 'app-ready']);
      await commandDown(parseArgs([], 'down'));
      await fs.rm(path.join(dir, '.portler/setup.json'));
      await commandUp(parseArgs(['app', '-d', '--no-setup'], 'up'));
      assert.deepEqual(await lines(), ['root', 'app-ready', 'root', 'app-ready']);
      await assert.rejects(fs.access(path.join(dir, '.portler/setup.json')));
    } finally {
      await commandDown(parseArgs([], 'down'));
    }
  });

});
