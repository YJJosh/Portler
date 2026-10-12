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
  // A required key is the deployment's to supply: its config value is not used (nor
  // resolved), so the check below names it instead of a dangling reference failing first.
  const required = config.production ? requiredEnvKeys(config, service) : [];
  const overridden = config.production ? new Set([...Object.keys(baseEnv), ...Object.keys(processEnv), ...required]) : undefined;
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
  // In development the env files' keys are forwarded too. In production a container gets only
  // what portler.yml names for it: root and service env (prod.env folded in), prod.require,
  // generated values and port_env. A value that is only in the use_env file or the shell is
  // not forwarded, so one env file can hold every secret of a deployment without each
  // container seeing all of them.
  const explicitKeys = new Set<string>([
    ...(config.production ? required : Object.keys(baseEnv)),
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

// A `prod.env` entry with no value (`KEY: ''`, or a bare `KEY:`) says the deployment must supply it.
const isBlankConfigValue = (value: unknown): boolean => value === '' || value === null;

/**
 * The keys the deployment must supply for a service (top-level plus its own), or
 * for the project: every `prod.require` entry, and every blank `prod.env` entry,
 * which means the same. A blank top-level entry is not required of a service
 * whose own env gives the key a value, since that value replaces the top-level one.
 */
export function requiredEnvKeys(config: PortlerConfig, service?: ServiceConfig): string[] {
  const keys = new Set([...(config.prod?.require ?? []), ...(service?.prod?.require ?? [])]);
  for (const [key, value] of Object.entries(config.prod?.env ?? {})) {
    if (!isBlankConfigValue(value)) continue;
    if (service && Object.hasOwn(service.env, key) && !isBlankConfigValue(service.env[key])) continue;
    keys.add(key);
  }
  for (const [key, value] of Object.entries(service?.prod?.env ?? {})) {
    if (isBlankConfigValue(value)) keys.add(key);
  }
  return [...keys];
}

/**
 * Under --prod every key in `required` must be present and non-empty in `env`.
 * A required key is the deployment's to supply: its config value, if any, is
 * not used, so a blank `prod.env` entry and a `require` entry mean the same.
 */
export function assertRequiredEnv(owner: string, required: string[], env: EnvMap): void {
  const missing = required.filter((key) => !Object.hasOwn(env, key) || env[key] === '');
  if (missing.length === 0) return;
  const one = missing.length === 1;
  throw new Error(
    `${owner} requires ${missing.join(', ')} in production (prod.require), and ${one ? 'it is' : 'they are'} missing or empty. ` +
      `Supply ${one ? 'it' : 'them'} through the platform environment or a use_env file.`,
  );
}

/**
 * What the deployment supplies: the use_env file, with the process (platform) env on top.
 * prod.require is checked against this, not against the final env: a value Portler adds
 * itself (generated PORTLER_* values, PORTLER_SERVICE_NAME, a port_env name such as PORT
 * filled with the port Portler chose) must not satisfy a requirement the deployment was
 * meant to meet.
 */
export function deploymentEnv(baseEnv: EnvMap, platformEnv: EnvMap = processEnvAsMap()): EnvMap {
  return { ...baseEnv, ...platformEnv };
}

/**
 * prod.require for the project and for each named service, against what the deployment supplies.
 * The project's explicit `prod.require` holds always. A root `prod.env` entry left blank belongs to
 * the env each service and the top-level setup steps see, so it is required by each named service
 * that does not set the key itself, and by the project only when its top-level setup steps run:
 * a service that overrides it must not be blocked by a project check it would pass on its own.
 */
export function assertProductionRequirements(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: { projectSetup?: boolean } = {},
): void {
  const supplied = deploymentEnv(baseEnv);
  const projectSetup = options.projectSetup !== false && (config.setup?.length ?? 0) > 0;
  assertRequiredEnv('the project', projectSetup ? requiredEnvKeys(config) : [...(config.prod?.require ?? [])], supplied);
  for (const name of serviceNames) {
    assertRequiredEnv(`service ${name}`, requiredEnvKeys(config, config.services[name]!), supplied);
  }
}

// A name that contains one of these words, or KEY/CERT as a whole word (SIGNING_KEY,
// ENCRYPTION_KEY, SSH_KEY, KEY), is masked. Over-masking is the safe direction;
// --reveal shows the value.
const SECRET_KEY = /(SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|APIKEY|SALT|(^|_)(KEYS?|CERT)(_|$))/i;
// The user part may be empty: `redis://:password@host` is the usual form for a password-only server.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s/@]+@/gi;

/** Hide secret-looking values, and the password of URL credentials, for printing. */
export function maskSecrets(env: EnvMap, reveal = false): EnvMap {
  if (reveal) return env;
  const output: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    output[key] = SECRET_KEY.test(key) && value !== '' ? '***' : value.replace(URL_PASSWORD, '$1***@');
  }
  return output;
}

/**
 * What `up --prod` hands a service: the keys it forwards, with the deployment's
 * values. Without a service, the project view: root env and generated values
 * as top-level setup sees them. Portler's own internal keys are left out.
 */
export function buildEffectiveEnv(
  config: PortlerConfig,
  service: ServiceConfig | null,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
): EnvMap {
  const output: EnvMap = {};
  if (service) {
    const { env, explicitKeys } = buildServiceEnv(config, service, baseEnv, generatedEnv, assignments);
    for (const key of explicitKeys) {
      if (env[key] !== undefined && !PORTLER_INTERNAL_ENV_KEYS.has(key)) output[key] = env[key];
    }
    return output;
  }
  const processEnv = processEnvAsMap();
  const required = config.production ? requiredEnvKeys(config) : [];
  const overridden = config.production ? new Set([...Object.keys(baseEnv), ...Object.keys(processEnv), ...required]) : undefined;
  const rootEnv = resolveEnvMap(config.env, assignments, overridden);
  const merged: EnvMap = config.production
    ? { ...rootEnv, ...baseEnv, ...processEnv, ...generatedEnv }
    : { ...processEnv, ...baseEnv, ...rootEnv, ...generatedEnv };
  for (const key of [...(config.production ? required : Object.keys(baseEnv)), ...Object.keys(config.env), ...Object.keys(generatedEnv)]) {
    if (merged[key] !== undefined) output[key] = merged[key];
  }
  return output;
}
