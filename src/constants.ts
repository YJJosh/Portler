import { createRequire } from 'node:module';
import type { PortRange } from './types/index.ts';

const requireJson = createRequire(import.meta.url);

// Read at runtime so --version cannot drift from package.json, which is one level
// up from src/ in dev and two from dist/src/ when published.
function readPackageVersion(): string {
  try {
    return (requireJson('../package.json') as { version: string }).version;
  } catch {
    return (requireJson('../../package.json') as { version: string }).version;
  }
}

export const VERSION: string = readPackageVersion();

export const PACKAGE_NAME = 'portler';

export const DEFAULT_PORT_RANGE: PortRange = { start: 51000, end: 59999 };
export const DEFAULT_HEALTHCHECK_TIMEOUT_MS = 60_000;
export const DEFAULT_HEALTHCHECK_INTERVAL_MS = 500;

/** The proxy's name in assignments and state files; reserved as a service name when `proxy:` exists. */
export const PROXY_SERVICE_NAME = 'proxy';
