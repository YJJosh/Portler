import os from 'node:os';
import path from 'node:path';

/** `~/.portler`, or PORTLER_GLOBAL_DIR (tests set it to isolate the registry). */
export function globalPortlerDir(): string {
  const override = process.env.PORTLER_GLOBAL_DIR;
  if (override && override.trim() !== '') return path.resolve(override);
  return path.join(os.homedir(), '.portler');
}

export function registryPath(): string {
  return path.join(globalPortlerDir(), 'ports.json');
}

export function registryLockDir(): string {
  return path.join(globalPortlerDir(), 'ports.lock');
}
