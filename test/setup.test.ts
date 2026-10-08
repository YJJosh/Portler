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
import { buildProjectEnv, runSetupStep, setupFingerprint } from '../src/setup/index.ts';

let dir: string;
let oldCwd: string;
let oldGlobal: string | undefined;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-setup-'));
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
  it('fingerprints commands, their order, cwd and mode', () => {
    const first = setupFingerprint(['a', 'b'], '/one', 'local:dev');
    assert.equal(first, setupFingerprint(['a', 'b'], '/one', 'local:dev'));
    assert.notEqual(first, setupFingerprint(['b', 'a'], '/one', 'local:dev'));
    assert.notEqual(first, setupFingerprint(['a', 'b'], '/two', 'local:dev'));
    assert.notEqual(first, setupFingerprint(['a', 'b'], '/one', 'local:prod'));
  });

  it('runs once automatically, reruns changed/forced steps, and separates modes', async () => {
    const cfg = await config('setup: echo root >> steps\nservices: {api: {command: echo}}');
    await runSetupStep(cfg, null, {}, 'local:dev');
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root']);
    await runSetupStep(cfg, null, {}, 'local:prod');
    await runSetupStep(cfg, null, {}, 'local:dev', true);
    cfg.setup = ['echo changed >> steps'];
    await runSetupStep(cfg, null, {}, 'local:dev');
    assert.deepEqual(await lines(), ['root', 'root', 'root', 'changed']);
  });

  it('stops at the first failed command and does not cache failure', async () => {
    const cfg = await config('setup: ["echo first >> steps", "exit 7", "echo last >> steps"]\nservices: {api: {command: echo}}');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(runSetupStep(cfg, null, {}, 'local:dev'), /setup project: command "exit 7" failed \(exit code 7\)/);
    }
    assert.deepEqual(await lines(), ['first', 'first']);
    const state = JSON.parse(await fs.readFile(path.join(dir, '.portler/setup.json'), 'utf8'));
    assert.deepEqual(state.steps, {});
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
