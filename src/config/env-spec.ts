import { isObject } from '../util/guards.ts';
import type { UnknownMap } from '../types/index.ts';

const SPEC_KEYS = ['value', 'default', 'required', 'secret', 'description'];

export interface EnvSpecFields {
  value?: unknown;
  default?: unknown;
  required?: boolean | 'prod';
  secret?: boolean;
  description?: string;
}

/**
 * An env entry written as a mapping instead of a plain value, e.g.
 * `KEY: { default: dev, required: true, secret: true, description: "..." }`.
 * The loader turns every mapping in an env block into one, so code that reads
 * env maps tells them from plain values with `instanceof`.
 */
export class EnvSpec {
  /** The config value. Like a plain value, it wins over the shell and use_env files in development. */
  declare value?: unknown;
  /** Used only when neither the shell nor a use_env file sets the key. */
  declare default?: unknown;
  /** true: must end up non-empty wherever it runs. 'prod': under --prod the deployment must supply it. */
  declare required?: boolean | 'prod';
  /** Hidden by `portler env`. false keeps a secret-looking name visible. */
  declare secret?: boolean;
  declare description?: string;

  constructor(fields: EnvSpecFields) {
    if (fields.value !== undefined) this.value = fields.value;
    if (fields.default !== undefined) this.default = fields.default;
    if (fields.required !== undefined) this.required = fields.required;
    if (fields.secret !== undefined) this.secret = fields.secret;
    if (fields.description !== undefined) this.description = fields.description;
  }
}

export function isEnvSpec(value: unknown): value is EnvSpec {
  return value instanceof EnvSpec;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function normalizeEnvSpec(raw: UnknownMap, name: string): EnvSpec {
  for (const key of Object.keys(raw)) {
    if (!SPEC_KEYS.includes(key)) throw new Error(`unknown key "${name}.${key}"; allowed keys: ${SPEC_KEYS.join(', ')}`);
  }
  if (raw.value !== undefined && raw.default !== undefined) {
    throw new Error(`${name} cannot set both value and default: value wins over your shell and .env files, default does not`);
  }
  for (const key of ['value', 'default']) {
    if (raw[key] !== undefined && !isScalar(raw[key])) throw new Error(`${name}.${key} must be a string, number or boolean`);
  }
  const required = raw.required;
  if (required !== undefined && required !== null && typeof required !== 'boolean' && required !== 'prod') {
    throw new Error(`${name}.required must be true, false or "prod"`);
  }
  if (raw.secret !== undefined && raw.secret !== null && typeof raw.secret !== 'boolean') throw new Error(`${name}.secret must be true or false`);
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') {
    throw new Error(`${name}.description must be a string`);
  }
  return new EnvSpec({
    value: raw.value,
    default: raw.default,
    required: required === null ? undefined : (required as boolean | 'prod' | undefined),
    secret: raw.secret === null ? undefined : (raw.secret as boolean | undefined),
    description: raw.description === null ? undefined : (raw.description as string | undefined),
  });
}

/** Turn every mapping value of an env block into an EnvSpec. Other values are kept as they are. */
export function normalizeEnvSpecs(env: UnknownMap, name: string): UnknownMap {
  const output: UnknownMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (isEnvSpec(value)) output[key] = value;
    else if (isObject(value)) output[key] = normalizeEnvSpec(value, `${name}.${key}`);
    else output[key] = value;
  }
  return output;
}

/**
 * The value an entry gives: a plain value or a spec's `value` (isDefault false),
 * or a spec's `default`. Undefined for a spec with neither, which only
 * describes the key.
 */
export function envEntryValue(entry: unknown): { value: unknown; isDefault: boolean } | undefined {
  if (!isEnvSpec(entry)) return { value: entry, isDefault: false };
  if (entry.value !== undefined) return { value: entry.value, isDefault: false };
  if (entry.default !== undefined) return { value: entry.default, isDefault: true };
  return undefined;
}

/**
 * One key of a higher env layer over a lower one (service over top-level,
 * docker.env over the service, prod.env over both). The higher layer's value
 * or default replaces the lower one's, while `required`, `secret` and
 * `description` stay unless the higher layer sets them too. So a plain
 * `docker.env` value does not drop `secret: true` from the service's entry.
 */
export function mergeEnvEntry(lower: unknown, upper: unknown): unknown {
  if (!isEnvSpec(lower)) return upper;
  if (!isEnvSpec(upper)) {
    return new EnvSpec({ value: upper ?? null, required: lower.required, secret: lower.secret, description: lower.description });
  }
  const ownValue = upper.value !== undefined || upper.default !== undefined;
  return new EnvSpec({
    value: ownValue ? upper.value : lower.value,
    default: ownValue ? upper.default : lower.default,
    required: upper.required ?? lower.required,
    secret: upper.secret ?? lower.secret,
    description: upper.description ?? lower.description,
  });
}

/** Every key of `upper` merged over `lower` with mergeEnvEntry. */
export function mergeEnvMaps(lower: UnknownMap, upper: UnknownMap | undefined): UnknownMap {
  const output: UnknownMap = { ...lower };
  for (const [key, value] of Object.entries(upper ?? {})) {
    output[key] = Object.hasOwn(lower, key) ? mergeEnvEntry(lower[key], value) : value;
  }
  return output;
}
