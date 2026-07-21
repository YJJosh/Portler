import { isObject as isObjectGuard } from '../util/guards.ts';
import type { UnknownMap } from '../types/index.ts';

export { isObject } from '../util/guards.ts';

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

export function optionalBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  return value;
}

export function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer within JavaScript's safe range`);
  }
  return value;
}

/**
 * A TCP port. Rejected early and by name, because an out-of-range port
 * otherwise surfaces much later as an opaque bind/allocation failure (port 0
 * in particular means "any port" to the OS and would silently defeat Portler's
 * whole reason for existing).
 */
export function optionalPort(value: unknown, name: string): number | undefined {
  const port = optionalNumber(value, name);
  if (port === undefined) return undefined;
  if (port < 1 || port > 65_535) throw new Error(`${name} must be a port between 1 and 65535, got ${port}`);
  return port;
}

/** A duration in milliseconds that must be strictly positive. */
export function optionalPositiveDuration(value: unknown, name: string): number | undefined {
  const duration = optionalNumber(value, name);
  if (duration === undefined) return undefined;
  if (duration <= 0) throw new Error(`${name} must be greater than 0, got ${duration}`);
  // Node clamps larger setTimeout values to 1ms. Accepting one here would turn
  // a supposedly slow readiness poll into a CPU-heavy busy loop.
  if (duration > 2_147_483_647) throw new Error(`${name} must not exceed 2147483647ms, got ${duration}`);
  return duration;
}

export function normalizeStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new Error(`${name} must be a string or an inline/block array of strings`);
}

/**
 * Normalize an env-like value into an object. Accepts a `KEY: value` mapping
 * or the Docker-Compose list form (`- KEY=value`).
 */
export function normalizeEnvObject(value: unknown, name: string): UnknownMap {
  if (value === undefined || value === null) return {};
  if (isObjectGuard(value)) return value;

  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const output: UnknownMap = {};

    for (const item of value) {
      const equals = item.indexOf('=');
      if (equals <= 0) {
        throw new Error(`${name} list entries must look like "KEY=value", got "${item}"`);
      }
      output[item.slice(0, equals)] = item.slice(equals + 1);
    }

    return output;
  }

  throw new Error(`${name} must be a mapping of "KEY: value" pairs or a list of "KEY=value" strings`);
}

export function normalizeEnvFiles(value: unknown): string[] {
  return normalizeStringArray(value, 'use_env');
}

export function normalizePortEnv(value: unknown): string[] {
  return normalizeStringArray(value, 'port_env');
}
