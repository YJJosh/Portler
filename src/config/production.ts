import { isObject, normalizeEnvObject, optionalBoolean, optionalString } from './scalars.ts';
import type { PortlerConfig, ProductionConfig, SetupStep } from '../types/index.ts';

const SETUP_STEP_KEYS = ['run', 'if_missing', 'always', 'watch'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `setup` is a command, a step object, or a list of either: `{run, if_missing}`
 * runs only while the path is absent, `{run, always}` on every up and setup,
 * `{run, watch}` once per checkout and again when one of the listed files
 * changes. A bare command is a `{run}` step.
 */
export function normalizeSetup(value: unknown, name: string): SetupStep[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [normalizeSetupStep(value, name)];
  if (isObject(value)) return [normalizeSetupStep(value, name)];
  if (!Array.isArray(value)) throw new Error(`${name} must be a string or a list of commands and {run, if_missing, always, watch} steps`);
  return value.map((item, index) => normalizeSetupStep(item, `${name}[${index}]`));
}

function normalizeSetupStep(item: unknown, name: string): SetupStep {
  if (typeof item === 'string') {
    if (item.trim() === '') throw new Error(`${name} must be a shell command`);
    return { run: item };
  }
  if (!isObject(item)) throw new Error(`${name} must be a command string or a {run, if_missing, always, watch} step`);
  for (const key of Object.keys(item)) {
    if (!SETUP_STEP_KEYS.includes(key)) throw new Error(`unknown key "${name}.${key}"; allowed keys: ${SETUP_STEP_KEYS.join(', ')}`);
  }
  const run = optionalString(item.run, `${name}.run`);
  if (run === undefined || run.trim() === '') throw new Error(`${name}.run must be a shell command`);
  const ifMissing = optionalString(item.if_missing, `${name}.if_missing`);
  if (ifMissing !== undefined && ifMissing.trim() === '') throw new Error(`${name}.if_missing must be a path`);
  const always = optionalBoolean(item.always, `${name}.always`, false);
  const watch = normalizeWatch(item.watch, `${name}.watch`);
  if (ifMissing !== undefined && always) throw new Error(`${name} cannot combine if_missing with always; pick one`);
  if (watch !== undefined && always) throw new Error(`${name} cannot combine watch with always; an always step runs every time anyway`);
  if (watch !== undefined && ifMissing !== undefined) throw new Error(`${name} cannot combine watch with if_missing; the path is that step's receipt`);
  const step: SetupStep = { run };
  if (ifMissing !== undefined) step.ifMissing = ifMissing;
  if (always) step.always = true;
  if (watch !== undefined) step.watch = watch;
  return step;
}

/** `watch` is a file or a list of files whose content becomes part of the step's receipt. */
function normalizeWatch(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) throw new Error(`${name} must be a file path or a list of file paths`);
  if (list.length === 0) throw new Error(`${name} must list at least one file`);
  if (list.some((entry) => entry.trim() === '')) throw new Error(`${name} must not contain an empty path`);
  return list;
}

/** `require` lists environment variable names, deduplicated. */
function normalizeRequire(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) throw new Error(`${name} must be a variable name or a list of variable names`);
  list.forEach((entry, index) => {
    if (!ENV_KEY.test(entry)) throw new Error(`${name}[${index}] must be an environment variable name, got "${entry}"`);
  });
  return [...new Set(list)];
}

export function normalizeProduction(value: unknown, name: string, service: boolean): ProductionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${name} must be an object`);
  const allowed = service ? ['setup', 'env', 'command', 'require'] : ['setup', 'env', 'require', 'services'];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`unknown key "${name}.${key}"; allowed keys: ${allowed.join(', ')}`);
  }
  const production: ProductionConfig = {
    setup: normalizeSetup(value.setup, `${name}.setup`),
    command: optionalString(value.command, `${name}.command`),
    env: normalizeEnvObject(value.env, `${name}.env`),
    require: normalizeRequire(value.require, `${name}.require`),
  };
  if (value.services !== undefined) {
    const list = typeof value.services === 'string' ? [value.services] : value.services;
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) throw new Error(`${name}.services must be a list of service names`);
    if (list.length === 0) throw new Error(`${name}.services must list at least one service`);
    production.services = [...new Set(list)];
  }
  return production;
}

/**
 * Under --prod only the services in top-level prod.services run; the rest are
 * external to the deployment (a managed database, a hosted queue) and reached
 * through values the deployment supplies. Dependencies on left-out services
 * are dropped, a proxy route to one is an error, and naming one on the
 * command line is an error. Without prod.services every service runs. The
 * names themselves are validated when the config loads.
 */
export function productionServices(config: PortlerConfig, prod = false, requested: string[] = []): PortlerConfig {
  const listed = config.prod?.services;
  if (!prod || listed === undefined) return config;
  const keep = new Set(listed);
  for (const name of requested) {
    if (config.services[name] && !keep.has(name)) {
      throw new Error(`service "${name}" is not in prod.services, so it does not run under --prod; the deployment provides it. Listed: ${listed.join(', ')}.`);
    }
  }
  const route = config.proxy?.routes.find((entry) => !keep.has(entry.service));
  if (route) {
    throw new Error(`proxy route ${route.prefix} targets service "${route.service}", which prod.services leaves out; add the service or remove the route`);
  }
  return {
    ...config,
    services: Object.fromEntries(
      Object.entries(config.services)
        .filter(([name]) => keep.has(name))
        .map(([name, service]) => [name, { ...service, dependsOn: service.dependsOn.filter((dependency) => keep.has(dependency.service)) }]),
    ),
  };
}

/** Apply after run-mode overrides so production values win in Docker mode too. */
export function applyProduction(config: PortlerConfig, prod = false): PortlerConfig {
  if (!prod) return config;
  const base = productionServices(config, true);
  return {
    ...base,
    production: true,
    setup: base.prod?.setup ?? base.setup,
    env: { ...base.env, ...base.prod?.env },
    services: Object.fromEntries(Object.entries(base.services).map(([name, service]) => [name, {
      ...service,
      setup: service.prod?.setup ?? service.setup,
      command: service.prod?.command ?? service.command,
      env: { ...service.env, ...service.prod?.env },
      docker: service.docker ? {
        ...service.docker,
        // `prod.command` replaces `command`, so it only reaches containers that run
        // `command` (flagged at normalization); a `docker:` block's own command,
        // even one spelled like `command`, or the image CMD is kept.
        command: service.docker.commandFromService
          ? service.prod?.command ?? service.docker.command
          : service.docker.command,
        env: { ...service.docker.env, ...service.prod?.env },
      } : undefined,
    }])),
  };
}
