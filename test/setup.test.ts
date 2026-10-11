import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandUp } from '../src/cli/commands/up.ts';
import { commandDown } from '../src/cli/commands/down.ts';
import { commandSetup } from '../src/cli/commands/setup.ts';
import { loadConfig } from '../src/config/loader.ts';
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
