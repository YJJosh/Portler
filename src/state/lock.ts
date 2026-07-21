import path from 'node:path';
import { withDirLock } from '../util/lock.ts';
import { portlerDir } from './index.ts';

// Critical sections are short (read one JSON file, mutate, write it), so a
// lock still held after this long belongs to a crashed process. A LIVE holder
// is never taken over regardless of age (see util/lock.ts), so these staleness
// windows only bound how long a crash blocks the next run.
const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 10_000;

// The lifecycle lock is held across a whole start/stop decision — which can
// include a Docker build or a rollout wait — so it must wait far longer before
// giving up. It is still only stolen from a provably dead owner.
const LIFECYCLE_STALE_MS = 30_000;
const LIFECYCLE_WAIT_MS = 120_000;

function projectLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'project.lock');
}

function lifecycleLockDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'lifecycle.lock');
}

/**
 * Serialize read-modify-write cycles on a project's `.portler/` files across
 * concurrent Portler invocations. Two `portler up <service>` runs in the same
 * project each read pids.json, add their own service, and write it back — with
 * no lock, the second write drops the first service's entry and `portler down`
 * then leaves that process orphaned.
 *
 * This is the INNER lock: it is taken and released around each file update, and
 * never wraps a lifecycle lock acquisition.
 */
export async function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(
    projectLockDir(projectDir),
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, description: 'project state' },
    fn,
  );
}

/**
 * Serialize whole lifecycle DECISIONS (`up`, `down`, `restart`) in one project.
 * The project lock only makes each individual pids.json write atomic, which is
 * not enough: `up` reads the running set, decides "api is not running", and
 * spawns it, while a concurrent `down` reads the same file and decides to stop
 * everything. Both writes are individually well-ordered and the result is still
 * wrong (a service running with no pid entry, or stopped a moment after being
 * started). This lock makes those read-decide-write cycles mutually exclusive.
 *
 * Ordering rule that keeps it deadlock-free: this is the OUTER lock. It is
 * acquired only at the top of a command, and the project lock is always taken
 * (and released) inside it — never the reverse. Nothing holding the project
 * lock ever asks for this one.
 *
 * It deliberately does NOT cover the foreground wait of `portler up` (which
 * lasts until the user hits Ctrl-C): holding it there would block every other
 * command in the project for the lifetime of the run. The TEARDOWN at the end of
 * that wait does run under the lock again — see withLifecycleLockForTeardown.
 */
export async function withLifecycleLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(
    lifecycleLockDir(projectDir),
    { staleMs: LIFECYCLE_STALE_MS, waitMs: LIFECYCLE_WAIT_MS, description: 'project lifecycle (up/down/restart)' },
    fn,
  );
}

/**
 * The lifecycle lock around the teardown that ends a FOREGROUND run (Ctrl-C, or
 * a service exiting). The long wait itself is unlocked, but the teardown is a
 * read-decide-write cycle exactly like `down`: it signals process groups, prunes
 * pids.json entries and releases port reservations. Racing it against a
 * concurrent `up` in the same project is how a freshly started service loses its
 * PID entry or has its port handed to someone else.
 *
 * If the lock cannot be acquired, teardown fails closed rather than running
 * unlocked. An unlocked old foreground teardown can race a newer `up`, read its
 * freshly written PID records, and stop the new services. Leaving the old run
 * visible for an explicit later `portler down` is safer than touching a newer
 * lifecycle decision without serialization.
 */
export function withLifecycleLockForTeardown<T>(
  projectDir: string,
  fn: () => Promise<T>,
  acquire: <R>(dir: string, run: () => Promise<R>) => Promise<R> = withLifecycleLock,
): Promise<T> {
  return acquire(projectDir, fn);
}
