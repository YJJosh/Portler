import { createRequire } from 'node:module';
import type { PortRange } from './types/index.ts';

const requireJson = createRequire(import.meta.url);

// Read at runtime so `npm version` bumps cannot drift from what --version
// reports. Two layouts: in dev this file is src/constants.ts (package.json
// one level up); published it is dist/src/constants.js (two levels up).
function readPackageVersion(): string {
  try {
    return (requireJson('../package.json') as { version: string }).version;
  } catch {
    return (requireJson('../../package.json') as { version: string }).version;
  }
}

export const VERSION: string = readPackageVersion();

export const DEFAULT_PORT_RANGE: PortRange = { start: 51000, end: 59999 };
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 60_000;
export const DEFAULT_HEALTHCHECK_INTERVAL_MS = 500;

/**
 * Name under which the reverse proxy appears in assignments, state.json,
 * pids.json, and the port registry. Reserved as a service name whenever a
 * `proxy:` block exists.
 */
export const PROXY_SERVICE_NAME = 'proxy';
