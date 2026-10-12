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
 * the service's own env overrides, and generated PORTLER_* values.
 *
 * In production (`config.production`, set by applyProduction) the deployment
 * wins over portler.yml instead: root config env, the service's own env, base
 * `.env` files, then the current process env. Generated PORTLER_* values and
 * `port_env` keys stay Portler's own in both orders, and containers receive the
 * same set of keys; only the values differ. A key the deployment supplies is not
 * resolved from config at all, so a reference that only works in development
 * cannot block the deployment's value.
 */
export function buildServiceEnv(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
): ServiceEnv {
  const processEnv = processEnvAsMap();
  // In production a key the deployment supplies (process env or use_env file) is left out
  // of resolution: its config value never applies, and a reference that only resolves in
  // development (a service with no assignment here) must not block the deployment's value.
  const overridden = config.production ? new Set([...Object.keys(baseEnv), ...Object.keys(processEnv)]) : undefined;
  // A root key the service's own env replaces (prod.env is folded in by then) is never used
  // for this service, in either mode, so it is not resolved either: a reference only another
  // service can resolve must not block the value this service actually gets.
  const rootSkip = new Set([...(overridden ?? []), ...Object.keys(service.env)]);
  const rootEnv = resolveEnvMap(config.env, assignments, rootSkip);
  const serviceEnv = resolveEnvMap(service.env, assignments, overridden);
  const env: EnvMap = config.production
    ? { ...rootEnv, ...serviceEnv, ...baseEnv, ...processEnv, ...generatedEnv, PORTLER_SERVICE_NAME: service.name }
    : { ...processEnv, ...baseEnv, ...rootEnv, ...serviceEnv, ...generatedEnv, PORTLER_SERVICE_NAME: service.name };

  // Raw config keys, so an overridden key still reaches containers with the deployment's value.
  const explicitKeys = new Set<string>([
    ...Object.keys(baseEnv),
    ...Object.keys(config.env),
    ...Object.keys(generatedEnv),
    ...Object.keys(service.env),
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
  if (!service) {
    return {
      ...resolveEnvMap(config.env, assignments),
      ...generatedEnv,
    };
  }

  // Same rule as buildServiceEnv: a root key the service's own env replaces is not resolved.
  const rootEnv = resolveEnvMap(config.env, assignments, new Set(Object.keys(service.env)));
  const serviceEnv = resolveEnvMap(service.env, assignments);
  const output: EnvMap = {
    ...rootEnv,
    ...serviceEnv,
    ...generatedEnv,
    PORTLER_SERVICE_NAME: service.name,
  };

  injectPortEnv(output, service, assignments[service.name]);

  return output;
}
