import { envEntryValue, isEnvSpec, mergeEnvMaps } from '../config/env-spec.ts';
import { isSecretEnvKey, resolveEnvMap, serviceViewer, type EnvViewer, type ResolveOptions } from './resolve.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig, UnknownMap } from '../types/index.ts';

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
  /**
   * Whether a key's value is secret, where the config decides it: `secret:` on
   * its entry, or a value that read a secret through an export. Keys missing
   * here are judged by their name (maskSecrets).
   */
  secrets: Map<string, boolean>;
}

export interface BuildEnvOptions {
  /**
   * Where the env is read. Default: where the service runs. Setup steps and
   * command healthchecks run on this machine even for a container service.
   */
  viewer?: EnvViewer;
  /** Resolve only this config key (for an export that reads it). */
  only?: string;
  /** false: the env an export reads, which must not use exports itself. */
  exports?: boolean;
}

interface ConfigLayers {
  /** Plain values and `value:` entries. */
  values: EnvMap;
  /** `default:` entries, which yield to the shell and the use_env files in every mode. */
  defaults: EnvMap;
  secrets: Map<string, boolean>;
}

/**
 * Resolve config env entries into the two layers buildServiceEnv stacks around the shell
 * and the use_env files. `supplied` are the keys those set: a default they set is never
 * used, so it is not resolved. In production a value they set is not used either, nor one
 * the deployment must supply (`required`).
 */
function resolveConfigLayers(
  config: PortlerConfig,
  entries: UnknownMap,
  assignments: Assignments,
  supplied: ReadonlySet<string>,
  required: readonly string[],
  options: ResolveOptions,
  only?: string,
): ConfigLayers {
  const values: UnknownMap = {};
  const defaults: UnknownMap = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (only !== undefined && key !== only) continue;
    const resolved = envEntryValue(entry);
    // An entry without a value still has its key checked by resolveEnvMap.
    (resolved?.isDefault ? defaults : values)[key] = entry;
  }
  const notUsed = new Set([...supplied, ...required]);
  const exportSecrets = new Set<string>();
  const output: ConfigLayers = {
    values: resolveEnvMap(values, assignments, config.production ? notUsed : undefined, options, exportSecrets),
    defaults: resolveEnvMap(defaults, assignments, notUsed, options, exportSecrets),
    secrets: new Map(),
  };
  for (const key of exportSecrets) output.secrets.set(key, true);
  for (const [key, entry] of Object.entries(entries)) {
    if (isEnvSpec(entry) && entry.secret !== undefined) output.secrets.set(key, entry.secret);
  }
  return output;
}

/**
 * The options that resolve a service's env: its own `self`, where it is read, and the
 * exports of other services, whose `${env.KEY}` reads the env that service itself gets.
 */
function serviceResolveOptions(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
  options: BuildEnvOptions,
): ResolveOptions {
  return {
    config,
    viewer: options.viewer ?? serviceViewer(config, service),
    self: service.name,
    exports: options.exports,
    exportEnv: exportEnvReader(config, baseEnv, generatedEnv, assignments),
  };
}

/** `${env.KEY}` in an export: the value the exporting service gets, as it runs. */
export function exportEnvReader(config: PortlerConfig, baseEnv: EnvMap, generatedEnv: EnvMap, assignments: Assignments): NonNullable<ResolveOptions['exportEnv']> {
  return (exporter, key) => {
    const target = config.services[exporter];
    if (!target) return undefined;
    const built = buildServiceEnv(config, target, baseEnv, generatedEnv, assignments, { only: key, exports: false });
    if (!Object.hasOwn(built.env, key)) return undefined;
    return { value: built.env[key]!, secret: built.secrets.get(key) ?? isSecretEnvKey(key) };
  };
}

/**
 * Resolve options for a service's healthcheck and other values read on this machine
 * with the service as `self`.
 */
export function hostResolveOptions(
  config: PortlerConfig,
  service: ServiceConfig | null,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
): ResolveOptions {
  return {
    config,
    viewer: 'host',
    ...(service ? { self: service.name } : {}),
    exportEnv: exportEnvReader(config, baseEnv, generatedEnv, assignments),
  };
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
 * precedence): `default:` entries, the current process env, base `.env` files,
 * root config env, the service's own env overrides, and generated PORTLER_*
 * values.
 *
 * In production (`config.production`, set by applyProduction) the deployment
 * wins over portler.yml instead: root config env, the service's own env, base
 * `.env` files, then the current process env. Generated PORTLER_* values and
 * `port_env` keys stay Portler's own in both orders, and containers receive the
 * same set of keys; only the values differ. A key the deployment supplies is not
 * resolved from config at all, so a reference that only works in development
 * cannot block the deployment's value.
 *
 * References resolve for where the env is read (`options.viewer`, by default
 * where the service runs), so `${db.address}` is the database's container alias
 * inside a container and its assigned port on this machine.
 */
export function buildServiceEnv(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
  options: BuildEnvOptions = {},
): ServiceEnv {
  const processEnv = processEnvAsMap();
  // In production a key the deployment supplies (process env or use_env file) is left out
  // of resolution: its config value never applies, and a reference that only resolves in
  // development (a service with no assignment here) must not block the deployment's value.
  // A required key is the deployment's to supply: its config value is not used (nor
  // resolved), so the check names it instead of a dangling reference failing first.
  const required = config.production ? requiredEnvKeys(config, service) : [];
  const supplied = new Set([...Object.keys(baseEnv), ...Object.keys(processEnv)]);
  // A root key the service's own env replaces (prod.env is folded in by then) is never used
  // for this service, in either mode, so it is not resolved either: a reference only another
  // service can resolve must not block the value this service actually gets.
  const entries = mergeEnvMaps(config.env, service.env);
  const resolveOptions = serviceResolveOptions(config, service, baseEnv, generatedEnv, assignments, options);
  const layers = resolveConfigLayers(config, entries, assignments, supplied, required, resolveOptions, options.only);
  const env: EnvMap = config.production
    ? { ...layers.defaults, ...layers.values, ...baseEnv, ...processEnv, ...generatedEnv, PORTLER_SERVICE_NAME: service.name }
    : { ...layers.defaults, ...processEnv, ...baseEnv, ...layers.values, ...generatedEnv, PORTLER_SERVICE_NAME: service.name };

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

  return { env, explicitKeys, secrets: layers.secrets };
}

/**
 * The env top-level setup steps get: like a service's, without a service of its own.
 * `default:` entries, the process env, base `.env` files, then root config env; in
 * production the deployment wins instead, and a key the deployment supplies is not
 * resolved from config at all (see buildServiceEnv). The whole process env is kept,
 * since setup steps run on this machine.
 */
export function composeProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments, generatedEnv: EnvMap = {}): ServiceEnv {
  const processEnv = processEnvAsMap();
  const required = config.production ? requiredEnvKeys(config) : [];
  const supplied = new Set([...Object.keys(baseEnv), ...Object.keys(processEnv)]);
  const options = hostResolveOptions(config, null, baseEnv, generatedEnv, assignments);
  const layers = resolveConfigLayers(config, config.env, assignments, supplied, required, options);
  const env: EnvMap = config.production
    ? { ...layers.defaults, ...layers.values, ...baseEnv, ...processEnv }
    : { ...layers.defaults, ...processEnv, ...baseEnv, ...layers.values };
  const explicitKeys = new Set([...(config.production ? required : Object.keys(baseEnv)), ...Object.keys(config.env)]);
  return { env, explicitKeys, secrets: layers.secrets };
}

/**
 * Build the subset of env values worth printing for `portler env`: generated
 * values, root overrides, and (optionally) a single service's env. Config
 * values, not the shell or the use_env files, except for a key whose entry
 * yields to them (a `default:`, or an entry with no value): there the value the
 * service gets is shown. An export reads the env its service really gets.
 * `secrets` collects which keys are secret: the config's say (see
 * ServiceEnv.secrets), and for a value taken from the shell or a use_env file,
 * also its name.
 */
export function buildPrintableEnv(
  config: PortlerConfig,
  service: ServiceConfig | null,
  generatedEnv: EnvMap,
  assignments: Assignments,
  baseEnv: EnvMap = {},
  secrets?: Map<string, boolean>,
): EnvMap {
  const entries = service ? mergeEnvMaps(config.env, service.env) : config.env;
  const options: ResolveOptions = service
    ? serviceResolveOptions(config, service, baseEnv, generatedEnv, assignments, {})
    : hostResolveOptions(config, null, baseEnv, generatedEnv, assignments);
  const supplied = { ...processEnvAsMap(), ...baseEnv };
  // Same rule as buildServiceEnv: a root key the service's own env replaces is not resolved.
  const layers = resolveConfigLayers({ ...config, production: false }, entries, assignments, new Set(Object.keys(supplied)), [], options);
  for (const [key, secret] of layers.secrets) secrets?.set(key, secret);
  const yielded: EnvMap = {};
  for (const [key, entry] of Object.entries(entries)) {
    const resolved = envEntryValue(entry);
    if ((resolved === undefined || resolved.isDefault) && Object.hasOwn(supplied, key)) {
      yielded[key] = supplied[key]!;
      secrets?.set(key, isSecretEnvKey(key, entry));
    }
  }
  const output: EnvMap = { ...layers.defaults, ...yielded, ...layers.values, ...generatedEnv };
  if (!service) return output;
  output.PORTLER_SERVICE_NAME = service.name;
  injectPortEnv(output, service, assignments[service.name]);
  return output;
}

// A `prod.env` entry with no value (`KEY: ''`, or a bare `KEY:`) says the deployment must supply it.
function isBlankConfigValue(value: unknown): boolean {
  if (!isEnvSpec(value)) return value === '' || value === null;
  const entry = envEntryValue(value);
  return entry === undefined || entry.value === '' || entry.value === null;
}

/** The env entries an owner sees: the project's top-level ones, or a service's merged over them. */
function ownerEntries(config: PortlerConfig, service?: ServiceConfig): UnknownMap {
  return service ? mergeEnvMaps(config.env, service.env) : config.env;
}

/** Keys an env entry marks `required: prod`: the deployment supplies them under --prod. */
export function specProductionKeys(config: PortlerConfig, service?: ServiceConfig): string[] {
  return Object.entries(ownerEntries(config, service))
    .filter(([, entry]) => isEnvSpec(entry) && entry.required === 'prod')
    .map(([key]) => key);
}

/**
 * The keys the deployment must supply for a service (top-level plus its own), or
 * for the project: every `prod.require` entry, every blank `prod.env` entry,
 * which means the same, and every env entry marked `required: prod`. A blank
 * top-level entry is not required of a service whose own env gives the key a
 * value, since that value replaces the top-level one.
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
  for (const key of specProductionKeys(config, service)) keys.add(key);
  return [...keys];
}

/**
 * The keys requiredEnvKeys asks for only because a `prod.env` entry is blank, not
 * because `prod.require` lists them; the error names which is which.
 */
export function blankRequiredKeys(config: PortlerConfig, service?: ServiceConfig): Set<string> {
  const listed = new Set([...(config.prod?.require ?? []), ...(service?.prod?.require ?? [])]);
  const blank = new Set<string>();
  for (const [key, value] of Object.entries({ ...config.prod?.env, ...service?.prod?.env })) {
    if (isBlankConfigValue(value) && !listed.has(key)) blank.add(key);
  }
  return new Set(requiredEnvKeys(config, service).filter((key) => blank.has(key)));
}

/** Descriptions of the env entries an owner sees, for error messages. */
export function envDescriptions(config: PortlerConfig, service?: ServiceConfig): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const [key, entry] of Object.entries(ownerEntries(config, service))) {
    if (isEnvSpec(entry) && entry.description) descriptions.set(key, entry.description);
  }
  return descriptions;
}

function describeKeys(keys: string[], descriptions: ReadonlyMap<string, string> | undefined): string {
  const lines = keys.filter((key) => descriptions?.has(key)).map((key) => `\n  ${key}: ${descriptions!.get(key)}`);
  return lines.join('');
}

function requiredEnvMessage(
  owner: string,
  required: string[],
  env: EnvMap,
  blank: ReadonlySet<string>,
  details: { fromSpec?: ReadonlySet<string>; descriptions?: ReadonlyMap<string, string> },
): string | undefined {
  const missing = required.filter((key) => !Object.hasOwn(env, key) || env[key] === '');
  if (missing.length === 0) return undefined;
  const one = missing.length === 1;
  const groups: Array<[string, string[]]> = [
    ['prod.require', missing.filter((key) => !blank.has(key) && !details.fromSpec?.has(key))],
    ['left blank in prod.env', missing.filter((key) => blank.has(key))],
    ['required: prod', missing.filter((key) => !blank.has(key) && details.fromSpec?.has(key))],
  ];
  const used = groups.filter(([, keys]) => keys.length > 0);
  const source = used.length === 1 ? used[0]![0] : used.map(([label, keys]) => `${label}: ${keys.join(', ')}`).join('; ');
  return (
    `${owner} requires ${missing.join(', ')} in production (${source}), and ${one ? 'it is' : 'they are'} missing or empty. ` +
    `Supply ${one ? 'it' : 'them'} through the platform environment or a use_env file.` +
    describeKeys(missing, details.descriptions)
  );
}

/**
 * Under --prod every key in `required` must be present and non-empty in `env`.
 * A required key is the deployment's to supply: its config value, if any, is
 * not used, so a blank `prod.env` entry, a `require` entry and `required: prod`
 * mean the same. `blank` names the keys that are required because a `prod.env`
 * entry is left blank, and `details.fromSpec` those an entry marks
 * `required: prod`, so the error points at the line the user actually wrote.
 */
export function assertRequiredEnv(
  owner: string,
  required: string[],
  env: EnvMap,
  blank: ReadonlySet<string> = new Set(),
  details: { fromSpec?: ReadonlySet<string>; descriptions?: ReadonlyMap<string, string> } = {},
): void {
  const message = requiredEnvMessage(owner, required, env, blank, details);
  if (message !== undefined) throw new Error(message);
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

/** The production check of one owner, with every detail its message uses. */
function productionMessage(config: PortlerConfig, owner: string, keys: string[], supplied: EnvMap, service?: ServiceConfig): string | undefined {
  return requiredEnvMessage(owner, keys, supplied, blankRequiredKeys(config, service), {
    fromSpec: new Set(specProductionKeys(config, service)),
    descriptions: envDescriptions(config, service),
  });
}

/**
 * Keys marked `required: true` that would be missing or empty for an owner. Checked
 * before anything resolves, the way the value would be chosen: the shell or a use_env
 * file, else a non-empty config value or default. In production a key the deployment
 * must supply only counts the deployment's value.
 */
function missingRequiredValues(config: PortlerConfig, supplied: EnvMap, service?: ServiceConfig): string[] {
  const deploymentOnly = new Set(config.production ? requiredEnvKeys(config, service) : []);
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(ownerEntries(config, service))) {
    if (!isEnvSpec(entry) || entry.required !== true) continue;
    if (Object.hasOwn(supplied, key) && supplied[key] !== '') continue;
    if (!deploymentOnly.has(key) && !isBlankConfigValue(entry)) continue;
    missing.push(key);
  }
  return missing;
}

/**
 * Check, before anything runs, every env value the project and the named services
 * need, and report all that are missing in one error: under --prod the keys the
 * deployment must supply (see requiredEnvKeys), and in every mode the keys an entry
 * marks `required: true`.
 *
 * The project's explicit `prod.require` holds always. A root `prod.env` entry left blank
 * (or marked `required: prod`) belongs to the env each service and the top-level setup
 * steps see, so it is required by each named service that does not set the key itself,
 * and by the project only when its top-level setup steps run: a service that overrides it
 * must not be blocked by a project check it would pass on its own. A key the project
 * reports is not repeated for each service.
 */
export function assertEnvRequirements(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: { projectSetup?: boolean } = {},
): void {
  const messages = envRequirementProblems(config, serviceNames, baseEnv, options);
  if (messages.length > 0) throw new Error(messages.join('\n'));
}

/**
 * What assertEnvRequirements would report, one message per line; empty when nothing is
 * missing. `deployment: false` leaves out the production keys, for a caller that checks
 * those itself (start).
 */
export function envRequirementProblems(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: { projectSetup?: boolean; deployment?: boolean; project?: boolean } = {},
): string[] {
  const supplied = deploymentEnv(baseEnv);
  // `project: true` checks the project's top-level env as if its setup steps ran (`portler env`),
  // `project: false` leaves the project out: a view of one service names that service.
  const projectSetup = options.project === true || (options.project !== false && options.projectSetup !== false && (config.setup?.length ?? 0) > 0);
  const messages: string[] = [];
  const names = [...serviceNames];

  if (config.production && options.deployment !== false) {
    const projectKeys = projectSetup ? requiredEnvKeys(config) : options.project === false ? [] : [...(config.prod?.require ?? [])];
    const projectMessage = productionMessage(config, 'the project', projectKeys, supplied);
    if (projectMessage) messages.push(projectMessage);
    const reported = new Set(projectKeys.filter((key) => !Object.hasOwn(supplied, key) || supplied[key] === ''));
    for (const name of names) {
      const service = config.services[name]!;
      const keys = requiredEnvKeys(config, service).filter((key) => !reported.has(key));
      const message = productionMessage(config, `service ${name}`, keys, supplied, service);
      if (message) messages.push(message);
    }
  }

  // required: true, grouped by key so a top-level key many services share is named once.
  const owners = new Map<string, string[]>();
  const descriptions = new Map<string, string>();
  const note = (owner: string, keys: string[], service?: ServiceConfig): void => {
    const known = envDescriptions(config, service);
    for (const key of keys) {
      owners.set(key, [...(owners.get(key) ?? []), owner]);
      if (known.has(key)) descriptions.set(key, known.get(key)!);
    }
  };
  const projectMissing = projectSetup ? missingRequiredValues(config, supplied) : [];
  note('the project', projectMissing);
  for (const name of names) {
    const service = config.services[name]!;
    note(`service ${name}`, missingRequiredValues(config, supplied, service).filter((key) => !projectMissing.includes(key)), service);
  }
  if (owners.size > 0) {
    const lines = [...owners].map(([key, who]) => `  ${key} (${who.join(', ')})${descriptions.has(key) ? `: ${descriptions.get(key)}` : ''}`);
    const one = owners.size === 1;
    messages.push(
      `required env ${one ? 'is' : 'are'} missing or empty (required: true):\n${lines.join('\n')}\n` +
        (config.production
          ? `Supply ${one ? 'it' : 'them'} through the platform environment or a use_env file.`
          : `Set ${one ? 'it' : 'them'} in your shell or in a use_env file such as .env.`),
    );
  }
  return messages;
}

/** The production half of assertEnvRequirements, kept for callers that only run under --prod. */
export function assertProductionRequirements(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: { projectSetup?: boolean } = {},
): void {
  assertEnvRequirements(config, serviceNames, baseEnv, options);
}

// The user part may be empty: `redis://:password@host` is the usual form for a password-only server.
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s/@]+@/gi;

/**
 * Hide secret values, and the password of URL credentials, for printing. A key is
 * secret when `secrets` says so (its entry's `secret:`, or a value read from a
 * secret through an export), otherwise when its name looks like one.
 */
export function maskSecrets(env: EnvMap, reveal = false, secrets: ReadonlyMap<string, boolean> = new Map()): EnvMap {
  if (reveal) return env;
  const output: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    const secret = secrets.get(key) ?? isSecretEnvKey(key);
    output[key] = secret && value !== '' ? '***' : value.replace(URL_PASSWORD, '$1***@');
  }
  return output;
}

/**
 * What `up --prod` hands a service: the keys it forwards, with the deployment's
 * values. Without a service, the project view: root env and generated values
 * as top-level setup sees them. Portler's own internal keys are left out.
 * `secrets` collects the config's say on which keys are secret.
 */
export function buildEffectiveEnv(
  config: PortlerConfig,
  service: ServiceConfig | null,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
  secrets?: Map<string, boolean>,
): EnvMap {
  const output: EnvMap = {};
  const built = service ? buildServiceEnv(config, service, baseEnv, generatedEnv, assignments) : composeProjectEnv(config, baseEnv, assignments, generatedEnv);
  for (const [key, secret] of built.secrets) secrets?.set(key, secret);
  const env = service ? built.env : { ...built.env, ...generatedEnv };
  const keys = service ? built.explicitKeys : new Set([...built.explicitKeys, ...Object.keys(generatedEnv)]);
  for (const key of keys) {
    if (env[key] !== undefined && !PORTLER_INTERNAL_ENV_KEYS.has(key)) output[key] = env[key];
  }
  return output;
}
