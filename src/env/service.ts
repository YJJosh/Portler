import { resolveEnvMap } from './resolve.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

function processEnvAsMap(): EnvMap {
  const output: EnvMap = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

/**
 * Env keys Portler injects for its own process-management concerns (see
 * applyNonInteractivePackageManagerDefaults). They target commands Portler
 * spawns on the host and must not leak into generated container specs.
 */
export const PORTLER_INTERNAL_ENV_KEYS: ReadonlySet<string> = new Set(['pnpm_config_verify_deps_before_run']);

export interface ServiceEnv {
  env: EnvMap;
  /**
   * The keys Portler itself composed (env files, root/service env, generated
   * values, port_env) as opposed to those inherited from the parent shell.
   * Container modes use this as their forwarding allowlist, then remove
   * PORTLER_INTERNAL_ENV_KEYS at the final container boundary.
   */
  explicitKeys: Set<string>;
}

function applyNonInteractivePackageManagerDefaults(env: EnvMap): boolean {
  if (env.pnpm_config_verify_deps_before_run !== undefined) return false;
  // Service stdin is intentionally not attached to the terminal. pnpm's
  // recursive script runner may otherwise try to auto-run `pnpm install`, then
  // abort when that install wants to prompt before recreating node_modules.
  // Keep this pnpm-specific and overridable instead of setting CI=true, which
  // changes behavior for many development servers.
  env.pnpm_config_verify_deps_before_run = 'false';
  return true;
}

/**
 * Set the service's port_env keys. Docker services see their declared
 * internal container port because the -p mapping translates the assigned host
 * port to it; local services see the assigned host port directly.
 */
function injectPortEnv(env: EnvMap, service: ServiceConfig, assignment: ServiceAssignment | undefined): void {
  if (!assignment) return;
  const port = service.docker && service.port !== undefined ? service.port : assignment.port;
  for (const key of service.portEnv) {
    env[key] = String(port);
  }
}

/**
 * Compose the full environment for a service, layering (lowest to highest
 * precedence): the current process env, base `.env` files, root config env,
 * generated PORTLER_* values, and the service's own env overrides.
 */
export function buildServiceEnv(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
): ServiceEnv {
  const rootEnv = resolveEnvMap(config.env, assignments);
  const serviceEnv = resolveEnvMap(service.env, assignments);
  const env: EnvMap = {
    ...processEnvAsMap(),
    ...baseEnv,
    ...rootEnv,
    ...generatedEnv,
    ...serviceEnv,
    PORTLER_SERVICE_NAME: service.name,
  };

  const explicitKeys = new Set<string>([
    ...Object.keys(baseEnv),
    ...Object.keys(rootEnv),
    ...Object.keys(generatedEnv),
    ...Object.keys(serviceEnv),
    'PORTLER_SERVICE_NAME',
  ]);

  if (applyNonInteractivePackageManagerDefaults(env)) {
    explicitKeys.add('pnpm_config_verify_deps_before_run');
  }

  const assignment = assignments[service.name];
  injectPortEnv(env, service, assignment);
  if (assignment) {
    for (const key of service.portEnv) explicitKeys.add(key);
  }

  return { env, explicitKeys };
}

/**
 * Build the subset of env values worth printing for `portler env`: generated
 * values, root overrides, and (optionally) a single service's env.
 */
export function buildPrintableEnv(
  config: PortlerConfig,
  service: ServiceConfig | null,
  generatedEnv: EnvMap,
  assignments: Assignments,
): EnvMap {
  const rootEnv = resolveEnvMap(config.env, assignments);

  if (!service) {
    return {
      ...generatedEnv,
      ...rootEnv,
    };
  }

  const serviceEnv = resolveEnvMap(service.env, assignments);
  const output: EnvMap = {
    ...generatedEnv,
    ...rootEnv,
    ...serviceEnv,
    PORTLER_SERVICE_NAME: service.name,
  };

  injectPortEnv(output, service, assignments[service.name]);

  return output;
}
