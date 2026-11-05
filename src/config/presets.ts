import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '../parse/yaml.ts';
import { isObject } from '../util/guards.ts';
import { didYouMean } from '../util/suggest.ts';
import { mergeEnvEntry, normalizeEnvSpecs } from './env-spec.ts';
import { normalizeEnvObject } from './scalars.ts';
import type { UnknownMap } from '../types/index.ts';

/**
 * The built-in presets: `presets/*.yml` at the package root. The source tree
 * runs this file as src/config/presets.ts, the published package as
 * dist/src/config/presets.js, so the folder is two or three levels up.
 */
export function builtInPresetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../presets'), path.resolve(here, '../../../presets')];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function builtInPresetNames(): string[] {
  try {
    return readdirSync(builtInPresetDir())
      .filter((file) => file.endsWith('.yml'))
      .map((file) => file.slice(0, -'.yml'.length))
      .sort();
  } catch {
    return [];
  }
}

/** `use: ./db.yml` (any value with a "/" or a .yml/.yaml ending) is a file; `use: postgres` a built-in preset. */
function isPresetPath(use: string): boolean {
  return use.includes('/') || /\.ya?ml$/.test(use);
}

/**
 * `postgres@16` and `./db.yml@2` name a version. An `@` in the file part of a
 * path (`./db@2.yml`, `../@scope/db.yml`) does not.
 */
function parseUse(value: string): { use: string; version?: string } {
  const at = value.lastIndexOf('@');
  if (at <= 0) return { use: value };
  const suffix = value.slice(at + 1);
  if (suffix.includes('/') || /\.ya?ml$/.test(suffix)) return { use: value };
  return { use: value.slice(0, at), version: suffix };
}

/** `${self.name}` and `${version}` are known before the service exists, e.g. for an image or a volume name. */
function substitutePresetValues(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return Object.entries(values).reduce((text, [name, replacement]) => text.replaceAll(`\${${name}}`, replacement), value);
  }
  if (Array.isArray(value)) return value.map((item) => substitutePresetValues(item, values));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitutePresetValues(item, values)]));
  return value;
}

/**
 * A preset with `versions:` never picks one by itself: a data volume only opens
 * with the major version that wrote it, so a default that moves in a later
 * Portler would break existing volumes. A version's keys replace the preset's.
 */
function applyPresetVersion(preset: UnknownMap, use: string, version: string | undefined, field: string): { keys: UnknownMap; values: Record<string, string> } {
  const { versions, ...keys } = preset;
  if (versions === undefined) {
    if (version !== undefined) throw new Error(`${field}: preset "${use}" has no versions, so "@${version}" means nothing. Use "${use}".`);
    return { keys, values: {} };
  }
  if (!isObject(versions) || Object.keys(versions).length === 0) throw new Error(`${field}: preset "${use}" must list its versions as a mapping of version: service keys`);
  const known = Object.keys(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (version === undefined) {
    throw new Error(
      `${field}: preset "${use}" needs a version, for example "${use}@${known[0]}". Versions: ${known.join(', ')}. ` +
        'Portler does not pick one, because a data volume only opens with the major version that wrote it.',
    );
  }
  if (!Object.hasOwn(versions, version)) {
    throw new Error(
      `${field}: preset "${use}" has no version "${version}". Versions: ${known.join(', ')}. ` +
        'For another version, set image: and volumes: on the service yourself.',
    );
  }
  const override = versions[version] ?? {};
  if (!isObject(override)) throw new Error(`${field}: version "${version}" of preset "${use}" must be a mapping of service keys`);
  return { keys: { ...keys, ...override }, values: { version } };
}

async function readPreset(use: string, version: string | undefined, serviceName: string, projectDir: string): Promise<UnknownMap> {
  const field = `services.${serviceName}.use`;
  let filePath: string;
  if (isPresetPath(use)) {
    filePath = path.resolve(projectDir, use);
  } else {
    const names = builtInPresetNames();
    if (!names.includes(use)) {
      throw new Error(
        `${field}: there is no built-in preset "${use}"${didYouMean(use, names)}. Built-in presets: ${names.join(', ') || '(none)'}. ` +
          'A path such as ./presets/db.yml uses a file of your own.',
      );
    }
    filePath = path.join(builtInPresetDir(), `${use}.yml`);
  }

  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`${field}: cannot read preset file ${filePath}: ${(error as Error).message}. Paths are relative to the project root (${projectDir}).`);
  }
  const preset = parseYaml(text, path.basename(filePath));
  if (!isObject(preset)) throw new Error(`${field}: preset ${filePath} must be a mapping of service keys`);
  const { keys, values } = applyPresetVersion(preset, use, version, field);
  if (keys.use !== undefined) throw new Error(`${field}: preset ${filePath} sets "use", but a preset cannot use another preset`);
  return substitutePresetValues(keys, { ...values, 'self.name': serviceName }) as UnknownMap;
}

/**
 * A service with `use:` starts from the preset's keys. The service's own keys
 * replace the preset's, except `env` and `exports`, which merge key by key: a
 * service that sets `POSTGRES_PASSWORD` keeps the preset's other variables, and
 * a plain value keeps the preset's `secret` and `description` for that key.
 */
export async function applyServicePreset(rawService: UnknownMap, serviceName: string, projectDir: string): Promise<UnknownMap> {
  const use = rawService.use;
  if (use === undefined || use === null) return rawService;
  if (typeof use !== 'string' || use.trim() === '') throw new Error(`services.${serviceName}.use must be a preset name or a path to a preset file`);

  const { use: target, version } = parseUse(use);
  const preset = await readPreset(target, version, serviceName, projectDir);
  const merged: UnknownMap = { ...preset };
  for (const [key, value] of Object.entries(rawService)) {
    if (key !== 'use') merged[key] = value;
  }

  const presetEnv = normalizeEnvSpecs(normalizeEnvObject(preset.env ?? preset.environment, `preset ${use} env`), `preset ${use} env`);
  const ownEnv = normalizeEnvSpecs(
    normalizeEnvObject(rawService.env ?? rawService.environment, `services.${serviceName}.env/environment`),
    `services.${serviceName}.env`,
  );
  const env: UnknownMap = { ...presetEnv };
  for (const [key, value] of Object.entries(ownEnv)) env[key] = Object.hasOwn(presetEnv, key) ? mergeEnvEntry(presetEnv[key], value) : value;
  delete merged.environment;
  merged.env = env;

  if (preset.exports !== undefined || rawService.exports !== undefined) {
    if (preset.exports !== undefined && !isObject(preset.exports)) throw new Error(`preset ${use}: exports must be a mapping of name: template`);
    if (rawService.exports !== undefined && rawService.exports !== null && !isObject(rawService.exports)) {
      throw new Error(`services.${serviceName}.exports must be a mapping of name: template`);
    }
    merged.exports = { ...(preset.exports as UnknownMap | undefined), ...(rawService.exports as UnknownMap | undefined) };
  }
  return merged;
}
