import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serviceLiveness } from '../src/process/liveness.ts';
import { isPidAlive, processGroupAlive, readPids } from '../src/process/pids.ts';
import { startZombieGroup, waitFor } from './zombie-group.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));

it('up refuses to overwrite an orphan group retained by down', { timeout: 20_000 }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-orphan-live-')));
  const groups = new Set<number>();
  const run = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PORTLER_GLOBAL_DIR: path.join(dir, 'global') },
  });
  try {
    await fs.writeFile(path.join(dir, 'portler.yml'), 'services: {worker: {command: "sleep 600 & echo $! > member; wait"}}\n');
    const started = run('up', '-d');
    assert.equal(started.status, 0, started.stderr);
    const info = (await readPids(dir))!.services.worker!;
    groups.add(info.pid);
    let member = 0;
    for (let attempt = 0; attempt < 100 && !member; attempt++) {
      member = Number(await fs.readFile(path.join(dir, 'member'), 'utf8').catch(() => ''));
      if (!member) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(member > 0, 'the service spawned a member before killing its leader');
    process.kill(info.pid, 'SIGKILL');
    assert.equal(await waitFor(() => isPidAlive(info.pid), false), false);
    assert.ok(processGroupAlive(info.pid));
    const down = run('down');
    assert.equal(down.status, 1, down.stderr);
    const pidsPath = path.join(dir, '.portler', 'pids.json');
    const retained = await fs.readFile(pidsPath, 'utf8');
    assert.equal((await readPids(dir))!.services.worker!.pid, info.pid);

    const up = run('up', '-d');
    // Track even a buggy replacement so fail-before never leaks a process.
    const replacement = (await readPids(dir))?.services.worker;
    if (replacement) groups.add(replacement.pid);
    assert.equal(up.status, 1, `up must not start a replacement: ${up.stdout} ${up.stderr}`);
    assert.match(up.stderr, /leader PID \d+ is gone but its process group still exists; ownership cannot be verified/);
    assert.match(up.stderr, /already running: worker/);
    assert.equal(await fs.readFile(pidsPath, 'utf8'), retained);
    const ps = run('ps');
    assert.match(ps.stdout, /running \(group\)/);
    assert.match(ps.stderr, /ownership cannot be verified/);
    const clean = run('clean');
    assert.equal(clean.status, 1, clean.stderr);
    assert.equal(await fs.readFile(pidsPath, 'utf8'), retained);
    assert.ok(isPidAlive(member), 'no unverified member was signalled');

    // The same group must remain tracked even if it once supervised a container.
    const liveness = await serviceLiveness(dir, { ...info, dockerContainer: 'old-container' }, async () => {
      throw new Error('a live group already establishes conservative liveness');
    });
    assert.equal(liveness.status, 'running');
    if (liveness.status === 'running') assert.equal(liveness.via, 'group');
  } finally {
    // These groups were all started by this test, including any buggy replacement.
    for (const pid of groups) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    for (const pid of groups) await waitFor(() => processGroupAlive(pid), false);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('a proven reused leader does not retain an unrelated live group', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    assert.ok(processGroupAlive(child.pid!));
    assert.deepEqual(await serviceLiveness('/unused', {
      pid: child.pid!, command: 'x', cwd: '/unused', startedAt: new Date().toISOString(), startToken: 'definitely-not-the-current-token',
    }), { status: 'dead' });
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
});

it('a Linux zombie-only group does not block a replacement', { skip: process.platform !== 'linux' }, async () => {
  const group = await startZombieGroup(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
  try {
    assert.equal(await waitFor(() => isPidAlive(group.pgid), false), false);
    assert.deepEqual(await serviceLiveness('/unused', {
      pid: group.pgid, command: 'x', cwd: '/unused', startedAt: new Date().toISOString(),
    }), { status: 'dead' });
  } finally {
    await group.release();
  }
});
