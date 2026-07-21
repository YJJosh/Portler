import { stripComment, unquoteDoubleQuoted } from './scan.ts';
import type { EnvMap } from '../types/index.ts';

function parseEnvValue(raw: string): string {
  const value = stripComment(raw.trim());

  if (value.startsWith('"') && value.endsWith('"')) {
    return unquoteDoubleQuoted(value);
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseDotEnv(text: string, sourceName = '.env'): EnvMap {
  const env: EnvMap = {};
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const rawLine = lines[lineNumber] ?? '';
    const trimmed = rawLine.trim();

    if (!trimmed || trimmed.startsWith('#')) continue;

    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const equalsIndex = line.indexOf('=');

    if (equalsIndex === -1) {
      throw new Error(`${sourceName}:${lineNumber + 1}: expected KEY=value`);
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1);

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${sourceName}:${lineNumber + 1}: invalid env key "${key}"`);
    }

    env[key] = parseEnvValue(rawValue);
  }

  return env;
}

export function formatDotEnv(env: EnvMap): string {
  const lines = Object.keys(env)
    .sort()
    .map((key) => `${key}=${formatDotEnvValue(env[key] ?? '')}`);

  return `${lines.join('\n')}\n`;
}

function formatDotEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
  return JSON.stringify(value);
}
