import { isObject, normalizeEnvObject, optionalBoolean, optionalString } from './scalars.ts';
import type { PortlerConfig, ProductionConfig, SetupStep } from '../types/index.ts';

const SETUP_STEP_KEYS = ['run', 'if_missing', 'always'];

/**
 * `setup` is a command, a step object, or a list of either: `{run, if_missing}`
 * runs only while the path is absent, `{run, always}` on every up and setup.
 * A bare command is a `{run}` step.
 */
export function normalizeSetup(value: unknown, name: string): SetupStep[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [{ run: value }];
  if (isObject(value)) return [normalizeSetupStep(value, name)];
  if (!Array.isArray(value)) throw new Error(`${name} must be a string or a list of commands and {run, if_missing, always} steps`);
  return value.map((item, index) => normalizeSetupStep(item, `${name}[${index}]`));
}

function normalizeSetupStep(item: unknown, name: string): SetupStep {
  if (typeof item === 'string') return { run: item };
  if (!isObject(item)) throw new Error(`${name} must be a command string or a {run, if_missing, always} step`);
  for (const key of Object.keys(item)) {
    if (!SETUP_STEP_KEYS.includes(key)) throw new Error(`unknown key "${name}.${key}"; allowed keys: ${SETUP_STEP_KEYS.join(', ')}`);
  }
  const run = optionalString(item.run, `${name}.run`);
  if (run === undefined || run.trim() === '') throw new Error(`${name}.run must be a shell command`);
  const ifMissing = optionalString(item.if_missing, `${name}.if_missing`);
  if (ifMissing !== undefined && ifMissing.trim() === '') throw new Error(`${name}.if_missing must be a path`);
  const always = optionalBoolean(item.always, `${name}.always`, false);
  if (ifMissing !== undefined && always) throw new Error(`${name} cannot combine if_missing with always; pick one`);
  const step: SetupStep = { run };
  if (ifMissing !== undefined) step.ifMissing = ifMissing;
  if (always) step.always = true;
  return step;
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
        // `prod.command` replaces `command`, so it only reaches containers that run
        // `command`; a `docker:` block's own command (or the image CMD) is kept.
        command: service.docker.command === service.command
          ? service.prod?.command ?? service.docker.command
          : service.docker.command,
        env: { ...service.docker.env, ...service.prod?.env },
      } : undefined,
    }])),
  };
}
