import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPidAlive, readPids } from '../src/process/pids.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const PORT_SERVICE = `${JSON.stringify(process.execPath)} -e "require('node:net').createServer().listen(process.env.PORT)"`;

async function project(yml: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-closed-output-')));
  await fs.writeFile(path.join(dir, 'portler.yml'), yml);
  cleanup.push(async () => {
    await portler(dir, 'down');
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function env(dir: string): NodeJS.ProcessEnv {
  return { ...process.env, PORTLER_GLOBAL_DIR: path.join(dir, 'global') };
}

async function portler(dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: dir, env: env(dir) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [status] = await once(child, 'close');
  return { status, stdout, stderr };
}

/**
 * Runs Portler in a shell pipeline whose reader stops early, as `portler ... | head -n 1` does. With `both`, stderr
 * goes into the same pipe; otherwise it is returned.
 */
async function withClosedOutput(dir: string, args: string[], options: { reader?: string; both?: boolean } = {}): Promise<{ status: number; stderr: string }> {
  const statusFile = path.join(dir, 'pipeline-status');
  const script = `{ "$@"; echo $? > "$STATUS_FILE"; } ${options.both ? '2>&1 ' : ''}| ${options.reader ?? 'true'}`;
  const child = spawn('sh', ['-c', script, 'sh', process.execPath, '--experimental-strip-types', cli, ...args], {
    cwd: dir,
    env: { ...env(dir), STATUS_FILE: statusFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await once(child, 'close');
  return { status: Number(await fs.readFile(statusFile, 'utf8')), stderr };
}

async function livePids(dir: string): Promise<Record<string, number>> {
  const services = (await readPids(dir))?.services ?? {};
  return Object.fromEntries(Object.entries(services).filter(([, info]) => isPidAlive(info.pid)).map(([name, info]) => [name, info.pid]));
}

const STACK = `services:
  db: {command: 'echo ready; sleep 600'}
  api: {command: '${PORT_SERVICE.replaceAll("'", "''")}', port: 4000, port_env: PORT, depends_on: [db]}
`;

it('restart starts every service again when the reader closes the pipe after one line', { timeout: 30_000 }, async () => {
  const dir = await project(STACK);
  assert.equal((await portler(dir, 'up', '-d')).status, 0);
  const before = await livePids(dir);
  assert.deepEqual(Object.keys(before).sort(), ['api', 'db']);

  const restart = await withClosedOutput(dir, ['restart'], { reader: 'head -n 1', both: true });

  assert.equal(restart.status, 0);
  const after = await livePids(dir);
  assert.deepEqual(Object.keys(after).sort(), ['api', 'db']);
  assert.notEqual(after.api, before.api);
  assert.notEqual(after.db, before.db);
});

it('up -d runs its setup step to the end and starts the service when stdout and stderr are closed', { timeout: 30_000 }, async () => {
  const dir = await project(`setup:
  - 'i=0; while [ $i -lt 2000 ]; do echo "out $i"; echo "err $i" >&2; i=$((i+1)); done; touch setup-done'
${STACK}`);

  const up = await withClosedOutput(dir, ['up', '-d'], { both: true });

  assert.equal(up.status, 0);
  await fs.access(path.join(dir, 'setup-done'));
  assert.deepEqual(Object.keys(await livePids(dir)).sort(), ['api', 'db']);
});

it('down stops everything when stdout is closed, without a stack trace', { timeout: 30_000 }, async () => {
  const dir = await project(STACK);
  assert.equal((await portler(dir, 'up', '-d')).status, 0);
  const pids = Object.values(await livePids(dir));

  const down = await withClosedOutput(dir, ['down']);

  assert.equal(down.status, 0, down.stderr);
  assert.doesNotMatch(down.stderr, /EPIPE|at /);
  assert.deepEqual(await livePids(dir), {});
  for (const pid of pids) assert.equal(isPidAlive(pid), false);
});

it('read-only commands end quietly when stdout is closed', { timeout: 30_000 }, async () => {
  const dir = await project(STACK);
  assert.equal((await portler(dir, 'up', '-d')).status, 0);
  // `logs --follow` only sees the closed pipe on a write, as `tail -f` does.
  for (let i = 0; i < 100 && !(await fs.readFile(path.join(dir, '.portler', 'logs', 'db.log'), 'utf8').catch(() => '')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  for (const args of [['ps'], ['ports'], ['env', 'api'], ['logs'], ['logs', '--follow']]) {
    const result = await withClosedOutput(dir, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '', args.join(' '));
  }
});

it('a setup step that leaves a process holding its output does not keep Portler waiting', { timeout: 30_000 }, async () => {
  const dir = await project("setup:\n  - {run: 'sleep 30 & echo $! > bg.pid; echo started', always: true}\nservices:\n  db: {command: 'sleep 600'}\n");
  cleanup.push(async () => {
    const pid = Number(await fs.readFile(path.join(dir, 'bg.pid'), 'utf8').catch(() => '0'));
    if (pid > 0) process.kill(pid, 'SIGKILL');
  });

  const startedAt = Date.now();
  const setup = await portler(dir, 'setup');

  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /started/);
  assert.ok(Date.now() - startedAt < 10_000, 'setup returned while the background process still runs');
});
