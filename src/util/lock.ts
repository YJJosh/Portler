/**
 * Cross-process lock on `mkdir`, which is atomic: one process creates the directory.
 *
 * Age alone never justifies a takeover, since a slow but live holder would then
 * share the lock. A takeover needs a stale lock AND an owner provably dead on this
 * host; a lock from another host (NFS, a container) is never taken over.
 *
 * Each acquisition writes a token, and release removes the lock only while the
 * token matches, so a holder that stalled and was taken over cannot delete the
 * new holder's lock.
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
 * Local, not imported from process/pids.ts: that would make the import cycle
 * util/lock -> process/pids -> state/lock -> util/lock.
 * EPERM means the pid exists under another user, so it is alive.
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
 * Waiting for the lock timed out. A separate class so callers that must go on
 * anyway (foreground-run teardown) can tell it from an error thrown inside `fn`.
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
  /** Throw LockTimeoutError after waiting this long. */
  waitMs: number;
  /** Used in the timeout message, e.g. "global port registry". */
  description: string;
  /** Rejects with the signal's reason; checked before every attempt, so an aborted wait never takes the lock. */
  signal?: AbortSignal;
  /** Tests only. Defaults to fs.stat. */
  stat?: (target: string) => Promise<LockDirStat>;
}

export interface LockDirStat {
  dev: number;
  ino: number;
  mtimeMs: number;
}

export interface LockOwner {
  pid: number;
  host: string;
  at: string;
  /** Unique per acquisition: proves the lock is still the one we took. */
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
 * Needs a stale lock AND an owner provably dead on this host. A lock from
 * another host is never taken over, since its holder may be mid-write; it
 * times out and the user removes it by hand. A missing or unreadable owner file
 * (holder crashed between mkdir and writing it) is taken over on age alone.
 */
export function isTakeoverAllowed(owner: LockOwner | null, ageMs: number, staleMs: number, thisHost: string): boolean {
  if (ageMs <= staleMs) return false;
  if (owner === null) return true;
  if (owner.host !== thisHost) return false;

  return !isProcessAlive(owner.pid);
}

function ownerProvablyDead(owner: LockOwner | null, thisHost: string): boolean {
  return owner !== null && owner.host === thisHost && !isProcessAlive(owner.pid);
}

function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.at === b.at && a.token === b.token;
}

/**
 * The rename makes removal exclusive: if another process moved it first we get
 * ENOENT, never deleting a lock that was re-acquired meanwhile. Returns null
 * when the lock is gone (retry at once), else the error that kept it in place
 * (wait, then time out, instead of a tight loop).
 */
async function takeOverStaleLock(lockDir: string): Promise<NodeJS.ErrnoException | null> {
  const abandoned = `${lockDir}.stale.${process.pid}.${randomToken()}`;

  try {
    await fs.rename(lockDir, abandoned);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return error as NodeJS.ErrnoException;
  }

  await fs.rm(abandoned, { recursive: true, force: true });
  return null;
}

/**
 * A changed token means another process took the lock over and is inside the
 * critical section; deleting it would let a third one in. Owner files without a
 * token (from an older Portler) are released on a pid and host match.
 */
async function releaseIfOurs(lockDir: string, token: string, description: string): Promise<void> {
  const owner = await readOwner(lockDir);

  if (owner === null) {
    if (await pathMissing(lockDir)) return;
    // Present but unreadable: acquire writes our owner file before returning, so it is not ours.
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

/**
 * Reads mtime and owner from one lock generation. A takeover between the reads
 * would pair the old mtime with the new owner, so the directory is read again
 * after the owner file and any change returns 'changed'.
 */
async function readLockSnapshot(
  lockDir: string,
  stat: (target: string) => Promise<LockDirStat>,
): Promise<{ mtimeMs: number; owner: LockOwner | null } | 'changed'> {
  const before = await stat(lockDir);
  const owner = await readOwner(lockDir);
  const after = await stat(lockDir);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) return 'changed';
  return { mtimeMs: after.mtimeMs, owner };
}

function timeoutError(
  lockDir: string,
  options: LockOptions,
  owner: LockOwner | null,
  thisHost: string,
  takeoverError: NodeJS.ErrnoException | null = null,
): LockTimeoutError {
  const held =
    owner === null
      ? ''
      : owner.host === thisHost
        ? ` It is held by pid ${owner.pid} on this host (since ${owner.at || 'unknown'}).`
        : ` It is held by pid ${owner.pid} on host "${owner.host}" (since ${owner.at || 'unknown'}), which this host ` +
          'cannot probe for liveness, so it is never taken over automatically. If that process is definitely gone, ' +
          `remove ${lockDir} by hand.`;

  const stuck =
    takeoverError === null
      ? ''
      : ` The lock is stale, but it could not be moved out of the way (${takeoverError.code ?? takeoverError.message}); ` +
        `check the permissions of ${path.dirname(lockDir)}, or remove ${lockDir} by hand.`;

  return new LockTimeoutError(`timed out waiting for the ${options.description} lock: ${lockDir}.${held}${stuck}`, lockDir);
}

async function acquire(lockDir: string, options: LockOptions): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const startedAt = Date.now();
  const host = os.hostname();
  const token = randomToken();
  const stat = options.stat ?? ((target: string) => fs.stat(target));
  let lastOwner: LockOwner | null = null;
  // Only ever moves later. A dead owner's extension survives another waiter
  // taking the lock over, and that replacement gets one waitMs window of its own.
  let deadline = startedAt + options.waitMs;
  let deadOwner: LockOwner | null = null;
  let replacementWindowGiven = false;
  // The latest the current owner can have taken the lock, whatever the mtime says.
  let seenOwner: LockOwner | null = null;
  let seenAt = startedAt;
  let takeoverError: NodeJS.ErrnoException | null = null;

  for (;;) {
    options.signal?.throwIfAborted();
    try {
      await fs.mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      try {
        const snapshot = await readLockSnapshot(lockDir, stat);
        if (snapshot === 'changed') {
          if (Date.now() > deadline) throw timeoutError(lockDir, options, lastOwner, host, takeoverError);
          continue;
        }
        lastOwner = snapshot.owner;
        const now = Date.now();
        if (lastOwner !== null && (seenOwner === null || !sameOwner(lastOwner, seenOwner))) {
          seenOwner = lastOwner;
          seenAt = now;
        }
        // The lock's clock may run ahead of ours. A future mtime must not push the
        // deadline out, so cap it at when we first saw this owner (fixed, so the
        // deadline cannot slide on every poll).
        const mtime = Math.min(snapshot.mtimeMs, lastOwner === null ? now : seenAt);

        if (isTakeoverAllowed(lastOwner, now - snapshot.mtimeMs, options.staleMs, host)) {
          takeoverError = await takeOverStaleLock(lockDir);
          // A takeover that keeps failing falls through to the sleep and the
          // deadline, so it ends in a timeout, not a busy loop.
          if (takeoverError === null) continue;
        }

        // A dead owner's lock becomes takeable once staleMs old, so wait for
        // that instead of failing every command started soon after a crash.
        if (ownerProvablyDead(lastOwner, host)) {
          deadline = Math.max(deadline, mtime + options.staleMs + DEAD_OWNER_MARGIN_MS);
          deadOwner = lastOwner;
        } else if (deadOwner !== null && !replacementWindowGiven && lastOwner !== null && !sameOwner(lastOwner, deadOwner)) {
          // Another waiter took the dead owner's lock: give it one waitMs from its acquisition.
          deadline = Math.max(deadline, mtime + options.waitMs);
          replacementWindowGiven = true;
        }
      } catch (statError) {
        // ENOENT: released since our mkdir, retry now. Other errors sleep, so they cannot busy-spin.
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
      }

      if (Date.now() > deadline) throw timeoutError(lockDir, options, lastOwner, host, takeoverError);

      await sleep(POLL_MS);
      continue;
    }

    const owner: LockOwner = { pid: process.pid, host, at: new Date().toISOString(), token };
    try {
      await fs.writeFile(path.join(lockDir, OWNER_FILE), JSON.stringify(owner), 'utf8');
    } catch (error) {
      // No release callback exists yet; a leftover directory would block every
      // later command until the stale timeout.
      await fs.rm(lockDir, { recursive: true, force: true });
      throw error;
    }

    return async () => {
      await releaseIfOurs(lockDir, token, options.description);
    };
  }
}

export async function withDirLock<T>(lockDir: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(lockDir, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}
