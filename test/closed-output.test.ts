import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPidAlive, readPids, writePids } from '../src/process/pids.ts';

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
async function withClosedOutput(dir: string, args: string[], options: { reader?: string; both?: boolean; path?: string } = {}): Promise<{ status: number; stderr: string }> {
  const statusFile = path.join(dir, 'pipeline-status');
  const script = `{ "$@"; echo $? > "$STATUS_FILE"; } ${options.both ? '2>&1 ' : ''}| ${options.reader ?? 'true'}`;
  const child = spawn('sh', ['-c', script, 'sh', process.execPath, '--experimental-strip-types', cli, ...args], {
    cwd: dir,
    env: { ...env(dir), STATUS_FILE: statusFile, ...(options.path ? { PATH: `${options.path}:${process.env.PATH}` } : {}) },
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
  assert.match(setup.stdout, /^started$/m);
  assert.match(setup.stderr, /left a process that still holds its output/);
  assert.ok(Date.now() - startedAt < 10_000, 'setup returned while the background process still runs');
});

it('setup keeps the order of stdout and stderr lines when both go into one pipe', { timeout: 30_000 }, async () => {
  const dir = await project("setup:\n  - 'i=0; while [ $i -lt 400 ]; do echo \"line $i\"; echo \"line $((i+1))\" >&2; i=$((i+2)); done'\nservices:\n  db: {command: 'sleep 600'}\n");
  const output = path.join(dir, 'merged.txt');

  const child = spawn('sh', ['-c', `"$@" 2>&1 | cat > ${JSON.stringify(output)}`, 'sh', process.execPath, '--experimental-strip-types', cli, 'setup'], { cwd: dir, env: env(dir), stdio: 'ignore' });
  const [status] = await once(child, 'close');

  assert.equal(status, 0);
  const lines = (await fs.readFile(output, 'utf8')).split('\n').filter((line) => line.startsWith('line '));
  assert.deepEqual(lines, Array.from({ length: 400 }, (_, i) => `line ${i}`));
});

it('commands exit 1 when their output fails for another reason than a closed reader', { timeout: 30_000 }, async () => {
  const dir = await project("services:\n  db: {command: 'i=0; while [ $i -lt 5000 ]; do echo \"log line $i\"; i=$((i+1)); done; sleep 600'}\n");
  assert.equal((await portler(dir, 'up', '-d')).status, 0);
  for (let i = 0; i < 100 && (await fs.readFile(path.join(dir, '.portler', 'logs', 'db.log'), 'utf8').catch(() => '')).length < 50_000; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // A file size limit makes Portler's writes fail with EFBIG; with 0 blocks even its only write fails.
  for (const [limit, args] of [['1', ['logs']], ['0', ['ps']], ['0', ['--version']]] as const) {
    const child = spawn('sh', ['-c', `ulimit -f ${limit}; "$@" > out.txt`, 'sh', process.execPath, '--experimental-strip-types', cli, ...args], { cwd: dir, env: env(dir), stdio: 'ignore' });
    const [status] = await once(child, 'close');
    assert.equal(status, 1, args.join(' '));
  }
});

// About 200 KB: more than the pipe holds, but little enough that the step exits while the reader still sleeps.
it('a setup step behind a slow reader keeps its output in order, without a leftover-process warning', { timeout: 30_000 }, async () => {
  const dir = await project(`setup:
  - 'i=0; while [ $i -lt 4000 ]; do echo "step-a line $i, padded to about fifty bytes"; i=$((i+1)); done'
  - 'echo step-b'
services:
  db: {command: 'sleep 600'}
`);
  const output = path.join(dir, 'slow.txt');
  const errors = path.join(dir, 'slow-err.txt');

  const child = spawn('sh', ['-c', `"$@" 2> ${JSON.stringify(errors)} | { sleep 2; cat > ${JSON.stringify(output)}; }`, 'sh', process.execPath, '--experimental-strip-types', cli, 'setup'], { cwd: dir, env: env(dir), stdio: 'ignore' });
  await once(child, 'close');

  const lines = (await fs.readFile(output, 'utf8')).split('\n');
  assert.equal(lines.filter((line) => line.startsWith('step-a ')).length, 4000);
  assert.ok(lines.indexOf('step-b') > lines.findLastIndex((line) => line.startsWith('step-a ')), 'step-b comes after all of step-a');
  assert.doesNotMatch(await fs.readFile(errors, 'utf8'), /left a process/);
});

it('logs --follow ends when the reader closes a pipe that only gets container stderr', { timeout: 30_000 }, async () => {
  const dir = await project("services:\n  api: {image: 'alpine:3'}\n");
  const bin = path.join(dir, 'fake-bin');
  await fs.mkdir(bin);
  // A fake `docker`: the container exists and logs only to stderr, one line every 100 ms.
  await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\n[ "$1" = logs ] || exit 0\ni=0; while [ $i -lt 200 ]; do echo "err $i" >&2; i=$((i+1)); sleep 0.1; done\n', { mode: 0o755 });
  const startedAt = new Date().toISOString();
  await writePids(dir, { version: 1, project: dir, startedAt, services: { api: { pid: 4_194_303, command: 'api', cwd: dir, startedAt, dockerContainer: 'portler-test-api', runMode: 'docker' } } });

  const startedMs = Date.now();
  const result = await withClosedOutput(dir, ['logs', '--follow'], { reader: 'head -n 1', both: true, path: bin });

  assert.equal(result.status, 0);
  assert.ok(Date.now() - startedMs < 10_000, 'logs stopped long before the fake container did');
});

it('setup keeps stdout and stderr apart when they go into different pipes', { timeout: 30_000 }, async () => {
  const dir = await project("setup:\n  - 'echo out-line; echo err-line >&2'\nservices:\n  db: {command: 'sleep 600'}\n");

  const setup = await portler(dir, 'setup');

  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /^out-line$/m);
  assert.doesNotMatch(setup.stdout, /^err-line$/m);
  assert.match(setup.stderr, /^err-line$/m);
});

it('logs keeps printing to stdout when only a separate stderr reader goes', { timeout: 30_000 }, async () => {
  const dir = await project("services:\n  api: {image: 'alpine:3'}\n");
  const bin = path.join(dir, 'fake-bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\n[ "$1" = logs ] || exit 0\necho diag >&2\nsleep 0.3\necho out-line\n', { mode: 0o755 });
  const startedAt = new Date().toISOString();
  await writePids(dir, { version: 1, project: dir, startedAt, services: { api: { pid: 4_194_303, command: 'api', cwd: dir, startedAt, dockerContainer: 'portler-test-api', runMode: 'docker' } } });
  const output = path.join(dir, 'stdout.txt');

  // stderr goes into a pipe that closes at once; stdout goes to a file.
  const child = spawn('sh', ['-c', `{ "$@" 2>&1 > ${JSON.stringify(output)}; echo $? > status; } | true`, 'sh', process.execPath, '--experimental-strip-types', cli, 'logs'], {
    cwd: dir, env: { ...env(dir), PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore',
  });
  await once(child, 'close');

  assert.equal((await fs.readFile(path.join(dir, 'status'), 'utf8')).trim(), '0');
  assert.match(await fs.readFile(output, 'utf8'), /^\[api\] out-line$/m);
});

it('a background writer behind a slow reader does not hold setup', { timeout: 60_000 }, async () => {
  const dir = await project("setup:\n  - '(yes bg-line | head -c 20000000) & echo fg-done'\nservices:\n  db: {command: 'sleep 600'}\n");
  const status = path.join(dir, 'status');

  // The reader takes 16 KiB every 20 ms, so the background writer keeps the relay waiting on it.
  const child = spawn('sh', ['-c', `{ "$@"; echo $? > ${JSON.stringify(status)}; } 2>&1 | perl -e 'while (sysread(STDIN, my $chunk, 16384)) { select(undef, undef, undef, 0.02) }'`, 'sh', process.execPath, '--experimental-strip-types', cli, 'setup'], {
    cwd: dir, env: env(dir), stdio: 'ignore',
  });
  cleanup.push(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let done = '';
  for (let i = 0; i < 200 && !done; i += 1) {
    done = await fs.readFile(status, 'utf8').catch(() => '');
    if (!done) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(done.trim(), '0', 'setup finished within 10 s, long before the background writer');
});

it('logs keeps exit code 1 for its own errors when the output is closed', { timeout: 30_000 }, async () => {
  const dir = await project("services:\n  db: {command: 'sleep 600'}\n");

  for (const args of [['logs', 'nope'], ['logs', 'db']]) {
    const result = await withClosedOutput(dir, args, { both: true });
    assert.equal(result.status, 1, args.join(' '));
  }
});

it('a setup step stopped by a signal still gets its last lines through a slow reader', { timeout: 30_000 }, async () => {
  const dir = await project(`setup:
  - 'trap "seq 1 30000; echo bye-last; exit 130" INT TERM; sleep 30 & echo $! > bg.pid; echo started; wait'
services:
  db: {command: 'sleep 600'}
`);
  const output = path.join(dir, 'signalled.txt');
  const pidFile = path.join(dir, 'portler.pid');
  // A background job of `sh -c` ignores SIGINT, so this sleep outlives the step.
  cleanup.push(async () => {
    const pid = Number(await fs.readFile(path.join(dir, 'bg.pid'), 'utf8').catch(() => '0'));
    if (pid > 0) process.kill(pid, 'SIGKILL');
  });
  // The reader takes 4 KiB every 10 ms: it pushes back when the step exits, but never stalls.
  const script = `sh -c 'echo $$ > "$PID_FILE"; exec "$@"' sh "$@" | perl -e 'while (sysread(STDIN, my $chunk, 4096)) { syswrite(STDOUT, $chunk); select(undef, undef, undef, 0.01) }' > ${JSON.stringify(output)}`;
  const child = spawn('sh', ['-c', script, 'sh', process.execPath, '--experimental-strip-types', cli, 'setup'], { cwd: dir, env: { ...env(dir), PID_FILE: pidFile }, stdio: 'ignore' });
  for (let i = 0; i < 200 && !/^started$/m.test(await fs.readFile(output, 'utf8').catch(() => '')); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  process.kill(Number(await fs.readFile(pidFile, 'utf8')), 'SIGINT');
  await once(child, 'close');

  assert.match(await fs.readFile(output, 'utf8'), /^bye-last$/m);
});
