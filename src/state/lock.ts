import path from 'node:path';
import { withDirLock } from '../util/lock.ts';
import { portlerDir } from './index.ts';

// These bound how long a crashed holder blocks the next run; a live holder is never taken
// over, whatever its age (see util/lock.ts).
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

// Held across a whole start/stop decision (a Docker build, a rollout wait), so it waits far
// longer. Still only stolen from a provably dead owner.
const LIFECYCLE_STALE_MS = 30_000;
const LIFECYCLE_WAIT_MS = 120_000;

function projectLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'project.lock');
}

function lifecycleLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'lifecycle.lock');
}

/**
 * Serializes read-modify-write of `.portler/` files, or two `up` runs drop one's pids.json entry
 * and orphan its process. The inner lock: per file update, never around taking the lifecycle lock.
 */
export async function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(
    projectLockDir(projectDir),
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, description: 'project state' },
    fn,
  );
}

/**
 * Serializes `up`/`down`/`restart`, or `up` and `down` act on one read and leave a service running
 * without an entry. The outer lock: only at the top of a command, the project lock always inside.
 * `up`'s foreground wait is unlocked; its teardown re-takes it (withLifecycleLockForTeardown).
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
 * A foreground run's teardown acts like `down`, so it takes the lifecycle lock and fails closed
 * (unlocked, it could stop a newer `up`'s services); the old run stays for a later `portler down`.
 */
export function withLifecycleLockForTeardown<T>(
  projectDir: string,
  fn: () => Promise<T>,
  acquire: <R>(dir: string, run: () => Promise<R>) => Promise<R> = withLifecycleLock,
): Promise<T> {
  return acquire(projectDir, fn);
}
