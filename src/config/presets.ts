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

/** `${self.name}` is the one value a preset needs before the service exists, e.g. in a volume name. */
function substituteSelfName(value: unknown, serviceName: string): unknown {
  if (typeof value === 'string') return value.replaceAll('${self.name}', serviceName);
  if (Array.isArray(value)) return value.map((item) => substituteSelfName(item, serviceName));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteSelfName(item, serviceName)]));
  return value;
}

async function readPreset(use: string, serviceName: string, projectDir: string): Promise<UnknownMap> {
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
  if (preset.use !== undefined) throw new Error(`${field}: preset ${filePath} sets "use", but a preset cannot use another preset`);
  return substituteSelfName(preset, serviceName) as UnknownMap;
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

  const preset = await readPreset(use, serviceName, projectDir);
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
