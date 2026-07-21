import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readPids, updatePids, writePids } from '../src/process/pids.ts';
import { waitForForegroundServices } from '../src/process/supervise.ts';
import { portlerDir } from '../src/state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown, withProjectLock } from '../src/state/lock.ts';
import { CorruptStateFileError } from '../src/util/json-file.ts';
import { isTakeoverAllowed, LockTimeoutError, withDirLock } from '../src/util/lock.ts';

const OPTIONS = { staleMs: 30_000, waitMs: 5_000, description: 'test' };

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-lock-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('isTakeoverAllowed', () => {
  const host = os.hostname();

  it('never takes over a lock that is not yet stale', () => {
    assert.equal(isTakeoverAllowed({ pid: process.pid, host, at: '' }, 1_000, 30_000, host), false);
  });

  it('does NOT take over a stale-looking lock whose owner is still alive', () => {
    // The regression: taking a lock over on mtime alone yanks it from a slow but
    // live holder (allocateAssignments can probe a whole port range while
    // holding it) and lets two writers into the critical section at once.
    assert.equal(isTakeoverAllowed({ pid: process.pid, host, at: '' }, 60_000, 30_000, host), false);
  });

  it('takes over a stale lock whose owner is provably dead', () => {
    // pid 2^22 is above the default pid_max and cannot be running.
    assert.equal(isTakeoverAllowed({ pid: 4_194_303, host, at: '' }, 60_000, 30_000, host), true);
  });

  it('takes over a stale lock with an unreadable owner file', () => {
    // The holder crashed between mkdir and writing the owner file.
    assert.equal(isTakeoverAllowed(null, 60_000, 30_000, host), true);
  });

  it('NEVER steals a lock held by another host, however stale it looks', () => {
    // The regression: age was treated as evidence of death for a foreign-host
    // owner. It is not — on a shared checkout (NFS, a devcontainer with its own
    // hostname) that owner may be mid-write, and stealing the lock puts two
    // writers in the critical section. We cannot probe that pid, so we never
    // claim it is gone; the wait times out with a message instead.
    assert.equal(isTakeoverAllowed({ pid: 1, host: 'other-host', at: '' }, 60_000, 30_000, host), false);
    assert.equal(isTakeoverAllowed({ pid: 1, host: 'other-host', at: '' }, 999_999_999, 30_000, host), false);
  });
});

describe('lock release', () => {
  it('does NOT delete a lock that was taken over while we held it', async () => {
    // The regression: a stalled holder finally runs its release and deletes the
    // lock directory — but that lock now belongs to the process that took it
    // over and is inside the critical section right now. A third process could
    // then walk straight in. Release must verify the token first.
    const lockDir = path.join(dir, 'test.lock');
    let ownerDuringSection: string | undefined;

    await withDirLock(lockDir, OPTIONS, async () => {
      ownerDuringSection = await fs.readFile(path.join(lockDir, 'owner'), 'utf8');
      // Simulate a takeover: the lock is now held by someone else entirely.
      await fs.writeFile(
        path.join(lockDir, 'owner'),
        JSON.stringify({ pid: 999_999, host: os.hostname(), at: new Date().toISOString(), token: 'someone-elses-token' }),
        'utf8',
      );
    });

    assert.ok(ownerDuringSection?.includes('token'), 'the lock records a per-acquisition token');
    // The new holder's lock survives our (late) release.
    const stillHeld = await fs.readFile(path.join(lockDir, 'owner'), 'utf8');
    assert.match(stillHeld, /someone-elses-token/, "the late releaser must not delete the new holder's lock");
  });

  it('releases a lock that is still ours', async () => {
    const lockDir = path.join(dir, 'test.lock');
    await withDirLock(lockDir, OPTIONS, async () => undefined);

    assert.equal(await fs.access(lockDir).then(() => true, () => false), false);
  });
});

describe('the lifecycle lock and the project lock do not deadlock', () => {
  it('nests project-lock work inside the lifecycle lock', async () => {
    // The ordering rule: lifecycle is the OUTER lock, project the INNER one, and
    // nothing that holds the project lock ever asks for the lifecycle lock. If
    // that were ever violated (or if they were the same lock), this would hang.
    await withLifecycleLock(dir, async () => {
      await updatePids(dir, (pids) => {
        pids.services.api = { pid: 1, command: 'x', cwd: dir, startedAt: new Date().toISOString() };
      });
      await withProjectLock(dir, async () => undefined);
    });

    const pids = await readPids(dir);
    assert.deepEqual(Object.keys(pids?.services ?? {}), ['api']);
  });

  it('serializes two lifecycle sections', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        withLifecycleLock(dir, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
        }),
      ),
    );

    assert.equal(maxConcurrent, 1, 'up/down/restart decisions must not overlap');
  });
});

describe('withDirLock', () => {
  it('serializes concurrent critical sections', async () => {
    const lockDir = path.join(dir, 'test.lock');
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withDirLock(lockDir, OPTIONS, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((resolve) => setTimeout(resolve, 10));
          concurrent -= 1;
        }),
      ),
    );

    assert.equal(maxConcurrent, 1, 'the lock must admit exactly one holder at a time');
  });

  it('releases the lock when the critical section throws', async () => {
    const lockDir = path.join(dir, 'test.lock');

    await assert.rejects(
      withDirLock(lockDir, OPTIONS, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );

    // The lock directory must be gone, or every later run would block on it.
    assert.equal(await fs.access(lockDir).then(() => true, () => false), false);
    await withDirLock(lockDir, OPTIONS, async () => undefined);
  });
});

describe('updatePids under the project lock', () => {
  it('does not lose entries when services are recorded concurrently', async () => {
    // The regression: `portler up a` and `portler up b` in one project each read
    // pids.json, add their own service, and write it back. Without a lock the
    // second write drops the first service — and `portler down` then never
    // learns that process's pid, orphaning it.
    const names = Array.from({ length: 10 }, (_unused, index) => `svc-${index}`);

    await Promise.all(
      names.map((name) =>
        updatePids(dir, (pids) => {
          pids.services[name] = {
            pid: 1_000 + Number(name.split('-')[1]),
            command: 'x',
            cwd: dir,
            startedAt: new Date().toISOString(),
          };
        }),
      ),
    );

    const pids = await readPids(dir);
    assert.deepEqual(Object.keys(pids?.services ?? {}).sort(), [...names].sort());
  });

  it('removes the PID file once the last service is dropped', async () => {
    await updatePids(dir, (pids) => {
      pids.services.api = { pid: 1, command: 'x', cwd: dir, startedAt: new Date().toISOString() };
    });
    await updatePids(dir, (pids) => {
      delete pids.services.api;
    });

    assert.equal(await readPids(dir), null);
  });

  it('REFUSES to overwrite a corrupt PID file instead of treating it as empty', async () => {
    // The regression: updatePids read the file with the "corruption means empty"
    // helper. A truncated pids.json therefore made `portler up` start from
    // scratch and overwrite the ONLY record of the pids it could not parse —
    // orphaning those processes with nothing left pointing at them. Recovery is
    // an explicit act (`clean --force`), not a silent side effect of `up`.
    await fs.mkdir(portlerDir(dir), { recursive: true });
    await fs.writeFile(path.join(portlerDir(dir), 'pids.json'), '{"version":1,"services":{ truncated', 'utf8');

    await assert.rejects(
      updatePids(dir, (pids) => {
        pids.services.api = { pid: 1, command: 'x', cwd: dir, startedAt: new Date().toISOString() };
      }),
      CorruptStateFileError,
    );

    // The broken file is still there, unmodified: nothing was lost.
    const raw = await fs.readFile(path.join(portlerDir(dir), 'pids.json'), 'utf8');
    assert.match(raw, /truncated/);
  });

  it('still writes normally after a valid file is restored', async () => {
    await writePids(dir, { version: 1, project: dir, startedAt: new Date().toISOString(), services: {} });
    await updatePids(dir, (pids) => {
      pids.services.api = { pid: 1, command: 'x', cwd: dir, startedAt: new Date().toISOString() };
    });

    assert.deepEqual(Object.keys((await readPids(dir))?.services ?? {}), ['api']);
  });
});

/**
 * The foreground wait of `portler up` is deliberately unlocked (it lasts until
 * Ctrl-C). The TEARDOWN at the end of it is not: it stops process groups, prunes
 * pids.json entries and releases ports — the same read-decide-write cycle the
 * lifecycle lock exists to serialize. Without it, Ctrl-C could race a concurrent
 * `portler up` in the same project.
 */
describe('withLifecycleLockForTeardown', () => {
  it('waits for a concurrent lifecycle command before tearing down', async () => {
    const order: string[] = [];
    let teardownDone: Promise<void>;

    await withLifecycleLock(dir, async () => {
      order.push('other-command:start');

      // A foreground `up` catching Ctrl-C while the other command holds the lock.
      teardownDone = withLifecycleLockForTeardown(dir, async () => {
        order.push('teardown');
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.deepEqual(order, ['other-command:start'], 'teardown must not run inside the other command');
      order.push('other-command:end');
    });

    await teardownDone!;
    assert.deepEqual(order, ['other-command:start', 'other-command:end', 'teardown']);
  });

  it('is not held during the foreground wait itself', async () => {
    // The counterpart: a `portler down` must be able to take the lock while an
    // `up` is sitting in its foreground wait, or it could never stop it.
    let taken = false;
    await withLifecycleLock(dir, async () => {
      taken = true;
    });
    assert.ok(taken);
  });

  it('fails closed when the lifecycle lock cannot be acquired', async () => {
    // Running an old foreground teardown without serialization can stop a newer
    // `up` after reading its fresh PID entries. Keep the old run visible for a
    // later explicit `down` rather than racing a newer lifecycle decision.
    const lifecycleLock = path.join(portlerDir(dir), 'lifecycle.lock');
    let torn = false;

    await assert.rejects(
      withLifecycleLockForTeardown(
        dir,
        async () => {
          torn = true;
        },
        () => Promise.reject(new LockTimeoutError('timed out waiting for the lifecycle lock', lifecycleLock)),
      ),
      /lifecycle lock/,
    );

    assert.equal(torn, false, 'teardown must not run outside the lifecycle lock');
  });

  it('does NOT re-run a teardown that timed out on one of its OWN locks', async () => {
    // The teardown takes further locks itself: the project lock (to rewrite
    // pids.json) and the global registry lock (to release ports), and both throw
    // the same LockTimeoutError class. Falling back on one of those would re-run
    // the entire teardown after it had already signalled process groups and
    // removed Docker resources. No teardown failure may cause a retry.
    const registryLock = path.join(dir, 'registry.lock');
    let runs = 0;

    await assert.rejects(
      withLifecycleLockForTeardown(dir, async () => {
        runs += 1;
        throw new LockTimeoutError('timed out waiting for the global port registry lock', registryLock);
      }),
      /global port registry/,
    );

    assert.equal(runs, 1, 'the teardown must run once, not twice');
  });

  it('does NOT retry a teardown that failed on its own terms', async () => {
    let runs = 0;

    await assert.rejects(
      withLifecycleLockForTeardown(dir, async () => {
        runs += 1;
        throw new Error('docker daemon is not running');
      }),
      /docker daemon is not running/,
    );

    assert.equal(runs, 1);
  });
});

describe('waitForForegroundServices', () => {
  /** A child that has already exited: exactly what triggers the teardown path. */
  async function exitedChild(): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    return child;
  }

  it('resolves (non-zero) instead of hanging when teardown fails', async () => {
    // The teardown now takes the lifecycle lock and can report failures, so it
    // can throw. An unhandled rejection here would leave `portler up` wedged
    // after Ctrl-C, with its services in an unknown state and no output at all.
    const children = new Map([['api', await exitedChild()]]);

    const code = await waitForForegroundServices(children, async () => {
      throw new Error('teardown blew up');
    });

    assert.equal(code, 1);
  });

  it('runs teardown exactly once and keeps the child\'s exit code', async () => {
    const children = new Map([['api', await exitedChild()]]);
    let runs = 0;

    const code = await waitForForegroundServices(children, async () => {
      runs += 1;
    });

    assert.equal(code, 0);
    assert.equal(runs, 1);
  });
});
