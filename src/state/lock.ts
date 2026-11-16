import path from 'node:path';
import { withDirLock } from '../util/lock.ts';
import { portlerDir } from './index.ts';

// Critical sections are short, so a lock held this long is a crashed process's.
// A live holder is never taken over (see util/lock.ts); these windows only bound
// how long a crash blocks the next run.
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

// Held across a whole start/stop decision (a Docker build, a rollout wait), so
// it waits far longer. Still only stolen from a provably dead owner.
const LIFECYCLE_STALE_MS = 30_000;
const LIFECYCLE_WAIT_MS = 120_000;

function projectLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'project.lock');
}

function lifecycleLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'lifecycle.lock');
}

/**
 * Serializes read-modify-write of `.portler/` files: two concurrent `up` runs
 * would otherwise drop one's pids.json entry and orphan its process. The inner
 * lock: taken per file update, never around a lifecycle lock acquisition.
 */
export async function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(
    projectLockDir(projectDir),
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, description: 'project state' },
    fn,
  );
}

/**
 * Serializes lifecycle decisions (`up`, `down`, `restart`): with only per-write
 * locking, `up` and a concurrent `down` can act on the same read and leave a
 * service running without an entry. The outer lock: taken only at the top of a
 * command, with the project lock always inside it, never the reverse. The
 * foreground wait of `up` is unlocked; its teardown takes the lock again
 * (withLifecycleLockForTeardown).
 */
export async function withLifecycleLock<T>(
  projectDir: string,
  fn: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return withDirLock(
    lifecycleLockDir(projectDir),
    {
      staleMs: LIFECYCLE_STALE_MS,
      waitMs: LIFECYCLE_WAIT_MS,
      description: 'project lifecycle (up/down/restart)',
      signal: options.signal,
    },
    fn,
  );
}

/**
 * The teardown ending a foreground run signals groups, prunes entries and frees
 * ports like `down`, so it takes the lifecycle lock. If that fails it fails
 * closed: unlocked, it could stop a newer `up`'s services. The old run stays
 * visible for a later `portler down`.
 */
export function withLifecycleLockForTeardown<T>(
  projectDir: string,
  fn: () => Promise<T>,
  acquire: <R>(dir: string, run: () => Promise<R>) => Promise<R> = withLifecycleLock,
): Promise<T> {
  return acquire(projectDir, fn);
}
