import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readProcessStartToken } from '../src/process/identity.ts';
import { isPidAlive, isPidRunning, writePids } from '../src/process/pids.ts';
import type { PidServiceInfo } from '../src/types/index.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanup.push(async () => {
    child.kill('SIGKILL');
  });
  return child;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid!;
}

/** The child of a stopped parent: it has exited, but nothing reaps it until the parent runs again. */
async function zombie(): Promise<number> {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 200)'], { stdio: 'ignore' });",
    "process.stdout.write(child.pid + '\\n', () => process.kill(process.pid, 'SIGSTOP'));",
  ].join('\n');
  const helper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  cleanup.push(async () => {
    if (helper.exitCode !== null || helper.signalCode !== null) return;
    helper.kill('SIGCONT');
    helper.kill('SIGKILL');
  });
  const [chunk] = await once(helper.stdout!, 'data');
  const pid = Number(String(chunk).trim());
  for (let i = 0; i < 100 && isPidAlive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isPidRunning(pid) && !isPidAlive(pid), true, 'the helper child is a zombie');
  return pid;
}

/**
 * A `docker` on PATH that answers `inspect` by container name: c-running and
 * c-exited carry the project's label, c-unreachable stands for a daemon that
 * cannot be asked.
 */
async function fakeDocker(dir: string, projectDir: string): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const bin = path.join(dir, 'fake-bin');
  const log = path.join(dir, 'docker-calls.log');
  await fs.mkdir(bin, { recursive: true });
  const inspected = (running: boolean) => JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': projectDir }, running });
  await fs.writeFile(
    path.join(bin, 'docker'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      'eval last=\\${$#}',
      'case "$last" in',
      `  c-running) printf '%s\\n' '${inspected(true)}' ;;`,
      `  c-exited) printf '%s\\n' '${inspected(false)}' ;;`,
      '  c-unreachable) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;',
      '  *) echo "Error: No such object: $last" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, calls: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

describe('portler ps', () => {
  it('reports each entry by the same liveness the teardown uses', { timeout: 15_000 }, async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-ps-')));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const projectDir = path.join(dir, 'project');
    await fs.mkdir(projectDir);
    await fs.writeFile(path.join(projectDir, 'portler.yml'), 'services:\n  app:\n    command: node -e ""\n');

    const live = sleeper();
    const recycled = sleeper();
    const liveToken = (await readProcessStartToken(live.pid!)) ?? undefined;
    const dead = await exitedPid();
    const zombiePid = await zombie();
    const entry = (pid: number, extra: Partial<PidServiceInfo> = {}): PidServiceInfo => ({ pid, command: 'x', cwd: projectDir, startedAt: new Date().toISOString(), ...extra });

    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: new Date().toISOString(),
      services: {
        live: entry(live.pid!, { startToken: liveToken }),
        exited: entry(dead),
        recycled: entry(recycled.pid!, { startToken: 'not the token of whatever runs there now' }),
        zombie: entry(zombiePid),
        'docker-live-pid': entry(live.pid!, { startToken: liveToken, dockerContainer: 'c-live-pid' }),
        'docker-running': entry(dead, { dockerContainer: 'c-running' }),
        'docker-exited': entry(dead, { dockerContainer: 'c-exited' }),
        'docker-unreachable': entry(dead, { dockerContainer: 'c-unreachable' }),
      },
    });

    const docker = await fakeDocker(dir, projectDir);
    const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'ps'], {
      cwd: projectDir,
      env: { ...process.env, PATH: `${docker.bin}${path.delimiter}${process.env.PATH ?? ''}`, PORTLER_GLOBAL_DIR: path.join(dir, 'global') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);

    const status = (service: string) => {
      const row = result.stdout.split('\n').find((line) => line.startsWith(`${service} `));
      assert.ok(row, `a row for ${service}`);
      return row.split(/ {2,}/)[3];
    };
    assert.equal(status('live'), 'running');
    assert.equal(status('exited'), 'dead (stale)');
    assert.equal(status('recycled'), 'dead (stale)', 'a pid now held by another process is not the service');
    assert.equal(status('zombie'), 'dead (stale)', 'a zombie has exited');
    assert.equal(status('docker-live-pid'), 'running');
    assert.equal(status('docker-running'), 'running (container)', 'the container runs on after its shell');
    assert.equal(status('docker-exited'), 'dead (stale)');
    assert.equal(status('docker-unreachable'), 'unknown');
    assert.match(result.stderr, /could not inspect container "c-unreachable" of docker-unreachable: Cannot connect to the Docker daemon/);

    const inspected = (await docker.calls()).map((call) => call.split(' ').at(-1));
    assert.deepEqual(inspected.sort(), ['c-exited', 'c-running', 'c-unreachable'], 'only the entries whose pid is gone are inspected');
  });
});
