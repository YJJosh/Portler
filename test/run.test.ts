/**
 * `portler run`: a command on this machine with a service's (or the project's)
 * env. These drive the real CLI against a temp project; nothing is started.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { loadConfig } from '../src/config/loader.ts';

const CONFIG = `env:
  STRIPE_KEY: { required: true }
tasks:
  migrate: { run: 'echo "migrate $PORTLER_SERVICE_NAME $DATABASE_URL"', service: api, description: Run the migrations }
  where: pwd
services:
  db:
    use: postgres
  api:
    command: node server.js
    cwd: api
    port: 4000
    depends_on: [db]
    env:
      DATABASE_URL: \${db.database_url}
    docker:
      image: example/api
`;

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
let projectDir: string;
let env: Record<string, string>;

beforeEach(async () => {
  projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-run-')));
  await fs.mkdir(path.join(projectDir, 'api'));
  await fs.writeFile(path.join(projectDir, 'portler.yml'), CONFIG, 'utf8');
  env = { ...(process.env as Record<string, string>), PORTLER_GLOBAL_DIR: path.join(projectDir, 'global'), STRIPE_KEY: 'sk' };
  delete env.DATABASE_URL;
  delete env.POSTGRES_PASSWORD;
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, 'run', ...args], { cwd: projectDir, env, encoding: 'utf8' });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('portler run', () => {
  it('without a terminal, stops the whole command tree on SIGTERM, background children too', async () => {
    const child = spawn(process.execPath, ['--experimental-strip-types', cli, 'run', 'api', '--', 'sh', '-c', 'sleep 300 & echo $! > sleeper.pid; wait'], {
      cwd: projectDir, env, stdio: ['pipe', 'ignore', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const pidFile = path.join(projectDir, 'api', 'sleeper.pid');
    let sleeper = 0;
    for (let tries = 0; tries < 200 && !sleeper; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sleeper = Number((await fs.readFile(pidFile, 'utf8').catch(() => '')).trim());
    }
    assert.ok(sleeper > 0, 'the command started');
    try {
      child.kill('SIGTERM');
      assert.equal(await exited, 143);
      for (let tries = 0; tries < 40 && alive(sleeper); tries++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(alive(sleeper), false, 'the backgrounded sleep was stopped too');
    } finally {
      if (alive(sleeper)) process.kill(sleeper, 'SIGKILL');
    }
  });

  it('lists the tasks when no name is given', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^migrate +Run the migrations \(api\)$/m);
    assert.match(result.stdout, /^where +pwd$/m);
  });

  it('runs a task with its service env, appending the words after --', () => {
    const result = run('migrate', '--', '--to', 'two words');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^migrate api postgres:\/\/postgres:postgres@localhost:\d+\/app --to two words$/m);
    const where = run('where');
    assert.equal(where.stdout.trim(), projectDir, 'a task without a service runs in the project root');
  });

  it('runs a command with a service env in its cwd, seen from this machine, and passes on the exit status', () => {
    const result = run('api', '--', 'sh', '-c', 'pwd; echo "$DATABASE_URL"; exit 3');
    assert.equal(result.status, 3);
    const [cwd, url] = result.stdout.trim().split('\n');
    assert.equal(cwd, path.join(projectDir, 'api'));
    assert.match(url!, /^postgres:\/\/postgres:postgres@localhost:\d+\/app$/);
    // Even the Docker view of the service reaches the database from here through its port.
    const docker = run('docker', 'api', '--', 'sh', '-c', 'echo "$DATABASE_URL"');
    assert.equal(docker.status, 0, docker.stderr);
    assert.match(docker.stdout, /@localhost:\d+\/app$/m);
  });

  it('warns about a missing required value but still runs', () => {
    delete env.STRIPE_KEY;
    const result = run('api', '--', 'true');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: required env is missing or empty \(required: true\):\n {2}STRIPE_KEY \(service api\)/);
  });

  it('names what is wrong with the request', () => {
    assert.match(run('api').stderr, /"api" is a service: put the command to run after "--"/);
    assert.match(run('migrat').stderr, /unknown task or service "migrat".*did you mean "migrate"/);
    assert.match(run('api', 'ls').stderr, /put the command after "--": portler run api -- ls/);
  });

  it('keeps the words after -- apart from the flags and names', () => {
    const parsed = parseArgs(['api', '--', 'psql', '-c', 'select 1', '--prod'], 'run');
    assert.deepEqual(parsed.passthrough, ['psql', '-c', 'select 1', '--prod']);
    assert.equal(parsed.prod, undefined, 'a flag after -- belongs to the command');
  });

  it('validates tasks when the config loads', async () => {
    const write = (text: string) => fs.writeFile(path.join(projectDir, 'portler.yml'), text);
    await write('tasks: {api: echo}\nservices: {api: {command: x}}\n');
    await assert.rejects(loadConfig(projectDir), /tasks\.api has the same name as a service/);
    await write('tasks: {seed: {run: x, service: apx}}\nservices: {api: {command: x}}\n');
    await assert.rejects(loadConfig(projectDir), /tasks\.seed\.service names unknown service "apx"/);
    await write('tasks: {docker: x}\nservices: {api: {command: x}}\n');
    await assert.rejects(loadConfig(projectDir), /tasks\.docker: "docker" is reserved/);
    await write('tasks: {seed: {cmd: x}}\nservices: {api: {command: x}}\n');
    await assert.rejects(loadConfig(projectDir), /unknown key "tasks\.seed\.cmd"/);
  });
});
