import fs from 'node:fs/promises';
import { withDirLock } from '../util/lock.ts';
import { globalPortlerDir, registryLockDir } from './locations.ts';

// Critical sections under withRegistryLock must finish well under this, or a
// crashed-holder takeover can hit a live one; allocateAssignments probes ports in it.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export async function ensureGlobalDir(): Promise<void> {
  await fs.mkdir(globalPortlerDir(), { recursive: true });
}

/** `signal` ends only the wait for the lock; once held, `fn` runs to completion. */
export async function withRegistryLock<T>(fn: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
  await ensureGlobalDir();

  return withDirLock(
    registryLockDir(),
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, description: 'global port registry', signal: options.signal },
    fn,
  );
}
