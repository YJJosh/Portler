/**
 * Cross-process advisory lock built on `mkdir` (atomic and portable: exactly
 * one process can create a given directory).
 *
 * Two failure modes drive the design.
 *
 * The crashed holder. Taking a lock over purely because its mtime is old is
 * wrong — a slow-but-alive holder (a long port-range probe, a stopped-then-
 * resumed process, a Docker build) gets its lock yanked out from under it and
 * two writers proceed at once. So a takeover requires BOTH that the lock looks
 * stale AND that its recorded owner is provably gone, which we can only
 * establish for an owner on THIS host. A lock held by another host (a shared
 * checkout over NFS, a container with its own hostname) is never stolen: age is
 * not evidence of death, and the whole point of the lock is the case where the
 * other side is still writing.
 *
 * The late releaser. A holder that stalls past staleMs, gets taken over, and
 * then finally runs its release must not delete the NEW holder's lock. So each
 * acquisition mints a token, writes it into the lock, and release only removes
 * the directory when the token still matches — a lock that has changed hands is
 * left strictly alone.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sleep } from './sleep.ts';

const OWNER_FILE = 'owner';
const POLL_MS = 100;
// Slack past a dead owner's stale time, for the lock's mtime and Date.now()
// coming from different clocks.
const DEAD_OWNER_MARGIN_MS = 1_000;

/**
 * Liveness check for a lock's recorded owner. Deliberately local rather than
 * imported from process/pids.ts: pids.ts takes the project lock, so importing
 * from it here would make util/lock -> process/pids -> state/lock -> util/lock
 * a cycle.
 *
 * EPERM means the pid exists but belongs to another user — alive, not dead.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Waiting for the lock timed out — distinguishable from an error thrown by the
 * critical section itself, so a caller that must make progress anyway (teardown
 * of a foreground run: leaving the services running would be worse) can tell the
 * two apart instead of pattern-matching on a message.
 */
export class LockTimeoutError extends Error {
  readonly lockDir: string;

  constructor(message: string, lockDir: string) {
    super(message);
    this.name = 'LockTimeoutError';
    this.lockDir = lockDir;
  }
}

export interface LockOptions {
  /** A lock older than this whose owner is provably dead may be taken over. */
  staleMs: number;
  /** Give up (throw) after waiting this long. */
  waitMs: number;
  /** Used in the timeout message, e.g. "global port registry". */
  description: string;
}

export interface LockOwner {
  pid: number;
  host: string;
  at: string;
  /** Unique per acquisition: proves a lock is still the one WE took. */
  token?: string;
}

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function parseOwner(text: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const owner = parsed as Partial<LockOwner>;
    if (typeof owner.pid !== 'number' || typeof owner.host !== 'string') return null;
    return {
      pid: owner.pid,
      host: owner.host,
      at: typeof owner.at === 'string' ? owner.at : '',
      token: typeof owner.token === 'string' ? owner.token : undefined,
    };
  } catch {
    return null;
  }
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await fs.readFile(path.join(lockDir, OWNER_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Whether a held lock may be taken over.
 *
 * Requires the lock to be old AND its owner to be provably dead, which is only
 * decidable for an owner on this host. A lock owned by another host is NEVER
 * taken over on age alone: the holder may be mid-write, and a stolen lock means
 * two concurrent writers to the same state file. Such a lock times out instead,
 * with a message telling the user to remove it by hand.
 *
 * A missing/garbage owner file is the one age-only takeover: the holder crashed
 * between mkdir and the owner write, so there is no liveness claim to respect.
 */
export function isTakeoverAllowed(owner: LockOwner | null, ageMs: number, staleMs: number, thisHost: string): boolean {
  if (ageMs <= staleMs) return false;
  if (owner === null) return true;
  if (owner.host !== thisHost) return false;

  return !isProcessAlive(owner.pid);
}

/** An owner on this host whose process no longer exists. */
function ownerProvablyDead(owner: LockOwner | null, thisHost: string): boolean {
  return owner !== null && owner.host === thisHost && !isProcessAlive(owner.pid);
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.at === b.at && a.token === b.token;
}

/**
 * Take over a stale lock. The rename makes the removal exclusive: if another
 * process renamed it first we get ENOENT and simply retry the mkdir, rather
 * than deleting a lock that has since been legitimately re-acquired.
 */
async function takeOverStaleLock(lockDir: string): Promise<void> {
  const abandoned = `${lockDir}.stale.${process.pid}.${randomToken()}`;

  try {
    await fs.rename(lockDir, abandoned);
  } catch {
    return;
  }

  await fs.rm(abandoned, { recursive: true, force: true });
}

/**
 * Release: only if the lock still carries OUR token. A lock whose token has
 * changed was taken over while we stalled, and now belongs to another process
 * that is inside the critical section right now — deleting it would let a third
 * process in alongside it. Legacy owner files without a token (written by an
 * older Portler still running) are released on a pid+host match.
 */
async function releaseIfOurs(lockDir: string, token: string, description: string): Promise<void> {
  const owner = await readOwner(lockDir);

  // The lock is gone already (taken over and released), or was never ours.
  if (owner === null) {
    if (await pathMissing(lockDir)) return;
    // Present but unreadable: our own owner file is written before we return
    // from acquire, so this is not our lock.
    return;
  }

  const ours = owner.token !== undefined ? owner.token === token : owner.pid === process.pid && owner.host === os.hostname();
  if (!ours) {
    process.stderr.write(
      `[portler] warning: the ${description} lock was taken over by another process while this one held it; ` +
        'leaving it in place. This run may have raced with another portler command.\n',
    );
    return;
  }

  await fs.rm(lockDir, { recursive: true, force: true });
}

async function pathMissing(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return false;
  } catch {
    return true;
  }
}

function timeoutError(lockDir: string, options: LockOptions, owner: LockOwner | null, thisHost: string): LockTimeoutError {
  const held =
    owner === null
      ? ''
      : owner.host === thisHost
        ? ` It is held by pid ${owner.pid} on this host (since ${owner.at || 'unknown'}).`
        : ` It is held by pid ${owner.pid} on host "${owner.host}" (since ${owner.at || 'unknown'}), which this host ` +
          'cannot probe for liveness, so it is never taken over automatically. If that process is definitely gone, ' +
          `remove ${lockDir} by hand.`;

  return new LockTimeoutError(`timed out waiting for the ${options.description} lock: ${lockDir}.${held}`, lockDir);
}

async function acquire(lockDir: string, options: LockOptions): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const startedAt = Date.now();
  const host = os.hostname();
  const token = randomToken();
  let lastOwner: LockOwner | null = null;
  // One deadline for the whole wait. It only ever moves later: once a dead
  // owner's lock has been found, the wait it justified holds even after
  // another waiter takes the lock over and becomes the (live) owner, and that
  // replacement gets one ordinary waitMs window of its own (see below).
  let deadline = startedAt + options.waitMs;
  let deadOwner: LockOwner | null = null;
  let replacementWindowGiven = false;
  // When we first saw the current owner: the latest that owner can have taken
  // the lock, whatever the directory's mtime says.
  let seenOwner: LockOwner | null = null;
  let seenAt = startedAt;

  for (;;) {
    try {
      await fs.mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      // Someone else owns the existing directory; continue into the wait path.
      try {
        const stat = await fs.stat(lockDir);
        lastOwner = await readOwner(lockDir);
        const now = Date.now();
        if (lastOwner !== null && (seenOwner === null || !sameOwner(lastOwner, seenOwner))) {
          seenOwner = lastOwner;
          seenAt = now;
        }
        // The lock directory's clock may run ahead of ours. A future mtime only
        // makes the lock look younger (never stale early); it must not push the
        // deadline past what we observed, so it counts as the moment we first
        // saw this owner (fixed, so the deadline cannot slide on every poll).
        const mtime = Math.min(stat.mtimeMs, lastOwner === null ? now : seenAt);

        if (isTakeoverAllowed(lastOwner, now - stat.mtimeMs, options.staleMs, host)) {
          await takeOverStaleLock(lockDir);
          continue;
        }

        // A holder on this host that is provably dead (a command killed while
        // inside the critical section) cannot release, and its lock becomes
        // ours to take once it is staleMs old. Waiting for that is bounded and
        // ends with the lock; giving up at waitMs instead makes every command
        // started shortly after the crash fail outright.
        if (ownerProvablyDead(lastOwner, host)) {
          deadline = Math.max(deadline, mtime + options.staleMs + DEAD_OWNER_MARGIN_MS);
          deadOwner = lastOwner;
        } else if (deadOwner !== null && !replacementWindowGiven && lastOwner !== null && !sameOwner(lastOwner, deadOwner)) {
          // Another waiter took the dead owner's lock over. We have been
          // waiting all along, so treat its acquisition as the moment our wait
          // started and allow its critical section the ordinary waitMs, once.
          deadline = Math.max(deadline, mtime + options.waitMs);
          replacementWindowGiven = true;
        }
      } catch (statError) {
        // ENOENT: the holder released the lock between our failed mkdir and the
        // stat — retry immediately. Anything else (e.g. permissions) falls
        // through to the sleep so it cannot busy-spin.
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }

      if (Date.now() > deadline) throw timeoutError(lockDir, options, lastOwner, host);

      await sleep(POLL_MS);
      continue;
    }

    const owner: LockOwner = { pid: process.pid, host, at: new Date().toISOString(), token };
    try {
      await fs.writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify(owner), 'utf8');
    } catch (error) {
      // We created this directory and have not exposed a release callback yet.
      // Leaving it behind on ENOSPC/EACCES blocks every later command until the
      // stale timeout, despite there never having been a lock holder.
      await fs.rm(lockDir, { recursive: true, force: true });
      throw error;
    }

    return async () => {
      await releaseIfOurs(lockDir, token, options.description);
    };
  }
}

/** Run `fn` while holding the lock, always releasing it afterwards. */
export async function withDirLock<T>(lockDir: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(lockDir, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
