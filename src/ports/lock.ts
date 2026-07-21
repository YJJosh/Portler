import fs from 'node:fs/promises';
import { withDirLock } from '../util/lock.ts';
import { globalPortlerDir, registryLockDir } from './locations.ts';

// Takeover threshold for a lock left behind by a crashed process. It also
// sets an invariant: critical sections under withRegistryLock must complete
// well under 30s — which matters because allocateAssignments probes ports
// (potentially a full range scan) while holding the lock.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export async function ensureGlobalDir(): Promise<void> {
  await fs.mkdir(globalPortlerDir(), { recursive: true });
}

/** Run `fn` while holding the global registry lock, releasing it afterwards. */
export async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureGlobalDir();

  return withDirLock(
    registryLockDir(),
    { staleMs: LOCK_STALE_MS, waitMs: LOCK_WAIT_MS, description: 'global port registry' },
    fn,
  );
}
