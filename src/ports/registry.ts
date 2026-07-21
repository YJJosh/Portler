import { isObject, isOptionalPort, isOptionalString, isPort, isString } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import { registryPath } from './locations.ts';
import { isPortFree } from './probe.ts';
import type { RegistryEntry, RegistryFile } from '../types/index.ts';

const REGISTRY_FREE_STALE_MS = 5 * 60_000;

function isRegistryEntry(value: unknown): value is RegistryEntry {
  return (
    isObject(value) &&
    isString(value.project) &&
    isString(value.service) &&
    isPort(value.port) &&
    isOptionalPort(value.desiredPort) &&
    isOptionalString(value.host) &&
    isString(value.assignedAt)
  );
}

function isRegistryFile(value: unknown): value is RegistryFile {
  if (!isObject(value) || value.version !== 1 || !isObject(value.ports)) return false;

  return Object.entries(value.ports).every(([portText, entry]) => {
    if (!/^\d+$/.test(portText)) return false;
    const port = Number.parseInt(portText, 10);
    return isPort(port) && isRegistryEntry(entry) && entry.port === port;
  });
}

export async function readRegistry(): Promise<RegistryFile> {
  const registry = await readValidatedJsonFile(
    registryPath(),
    'global Portler port registry',
    isRegistryFile,
    'portler clean --global --force',
  );
  return registry ?? { version: 1, ports: {} };
}

export async function writeRegistry(registry: RegistryFile): Promise<void> {
  await writeJsonFile(registryPath(), registry);
}

function parseAssignedAt(value: string | undefined): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Drop registry entries that are old and whose port is now free, plus any
 * malformed entries. Mutates the passed-in registry.
 */
export async function pruneRegistry(registry: RegistryFile): Promise<void> {
  const now = Date.now();

  for (const [portText, entry] of Object.entries(registry.ports)) {
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port)) {
      delete registry.ports[portText];
      continue;
    }

    const age = now - parseAssignedAt(entry.assignedAt);
    // Older registries did not store host and were always probed on loopback.
    // Probing only 127.0.0.1 for a reservation bound to ::1/a LAN interface can
    // incorrectly declare a live service stale and hand its port out again.
    if (age > REGISTRY_FREE_STALE_MS && (await isPortFree(port, entry.host ?? '127.0.0.1'))) {
      delete registry.ports[portText];
    }
  }
}
