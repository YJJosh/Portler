import os from 'node:os';
import path from 'node:path';

/**
 * The shared, machine-wide `~/.portler` directory. Overridable via the
 * PORTLER_GLOBAL_DIR environment variable (used by tests to isolate the
 * global port registry, and available for unusual home-directory setups).
 */
export function globalPortlerDir(): string {
  const override = process.env.PORTLER_GLOBAL_DIR;
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.portler');
}

/** Path to the global port registry JSON file. */
export function registryPath(): string {
  return path.join(globalPortlerDir(), 'ports.json');
}

/** Path to the lock directory guarding the global port registry. */
export function registryLockDir(): string {
  return path.join(globalPortlerDir(), 'ports.lock');
}
