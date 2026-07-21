import type { UnknownMap } from '../types/index.ts';

/** Type guard for plain (non-array) objects, e.g. parsed YAML/JSON records. */
export function isObject(value: unknown): value is UnknownMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

export function isOptionalPort(value: unknown): value is number | undefined {
  return value === undefined || isPort(value);
}
