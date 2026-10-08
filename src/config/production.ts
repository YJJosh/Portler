import { isObject, normalizeEnvObject, optionalString } from './scalars.ts';
import type { PortlerConfig, ProductionConfig } from '../types/index.ts';

export function normalizeSetup(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  throw new Error(`${name} must be a string or a list of strings`);
}

export function normalizeProduction(value: unknown, name: string, service: boolean): ProductionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const allowed = service ? ['setup', 'env', 'command'] : ['setup', 'env'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown key "${name}.${key}"; allowed keys: ${allowed.join(', ')}`);
  }
  return {
    setup: normalizeSetup(value.setup, `${name}.setup`),
    command: optionalString(value.command, `${name}.command`),
    env: normalizeEnvObject(value.env, `${name}.env`),
  };
}

/** Apply after run-mode overrides so production values win in Docker mode too. */
export function applyProduction(config: PortlerConfig, prod = false): PortlerConfig {
  if (!prod) return config;
  return {
    ...config,
    setup: config.prod?.setup ?? config.setup,
    env: { ...config.env, ...config.prod?.env },
    services: Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, {
      ...service,
      setup: service.prod?.setup ?? service.setup,
      command: service.prod?.command ?? service.command,
      env: { ...service.env, ...service.prod?.env },
      docker: service.docker ? {
        ...service.docker,
        command: service.prod?.command ?? service.docker.command,
        env: { ...service.docker.env, ...service.prod?.env },
      } : undefined,
    }])),
  };
}
