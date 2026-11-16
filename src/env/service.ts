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
 * Keys Portler injects for commands it spawns on the host
 * (applyNonInteractivePackageManagerDefaults); never forwarded into containers.
 */
export const PORTLER_INTERNAL_ENV_KEYS: ReadonlySet<string> = new Set(['pnpm_config_verify_deps_before_run']);

export interface ServiceEnv {
  env: EnvMap;
  /**
   * Keys Portler composed (env files, config env, generated values, port_env), not inherited
   * from the shell. Containers forward only these, minus PORTLER_INTERNAL_ENV_KEYS.
   */
  explicitKeys: Set<string>;
  /**
   * Secrecy the config decides: an entry's `secret:`, or a value read from an exported secret.
   * Missing keys are judged by name (maskSecrets).
   */
  secrets: Map<string, boolean>;
}

export interface BuildEnvOptions {
  /**
   * Where the env is read. Default: where the service runs. Setup steps and command
   * healthchecks run on this machine even for a container service.
   */
  viewer?: EnvViewer;
  /** start gives the deployment precedence even without applying production overrides. */
  deploymentPrecedence?: boolean;
  /** The platform env start is composing; defaults to this process's env. */
  platformEnv?: EnvMap;
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
 * Resolve config entries into the two layers stacked around the shell and use_env files.
 * A default for a `supplied` key is never used, so it is not resolved; with deployment
 * precedence neither is a value for a `supplied` or `required` key.
 */
function resolveConfigLayers(
  deploymentPrecedence: boolean,
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
    values: resolveEnvMap(values, assignments, deploymentPrecedence ? notUsed : undefined, options, exportSecrets),
    defaults: resolveEnvMap(defaults, assignments, notUsed, options, exportSecrets),
    secrets: new Map(),
  };
  for (const [key, entry] of Object.entries(entries)) {
    if (isEnvSpec(entry) && entry.secret !== undefined) output.secrets.set(key, entry.secret);
  }
  // `secret: false` only disables the name guess: a value read from an exported secret stays secret.
  for (const key of exportSecrets) output.secrets.set(key, true);
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
    exportEnv: exportEnvReader(config, baseEnv, generatedEnv, assignments, options),
  };
}

/** `${env.KEY}` in an export: the value the exporting service gets, as it runs. */
export function exportEnvReader(config: PortlerConfig, baseEnv: EnvMap, generatedEnv: EnvMap, assignments: Assignments, options: Pick<BuildEnvOptions, 'deploymentPrecedence' | 'platformEnv'> = {}): NonNullable<ResolveOptions['exportEnv']> {
  return (exporter, key) => {
    const target = config.services[exporter];
    if (!target) return undefined;
    const built = buildServiceEnv(config, target, baseEnv, generatedEnv, assignments, {
      deploymentPrecedence: options.deploymentPrecedence, platformEnv: options.platformEnv, only: key, exports: false,
    });
    if (!Object.hasOwn(built.env, key)) return undefined;
    return { value: built.env[key]!, secret: built.secrets.get(key) ?? isSecretEnvKey(key) };
  };
}

/** For a service's healthcheck and other values read on this machine with the service as `self`. */
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
  // Service stdin is not a terminal, so pnpm's auto-run `pnpm install` aborts when it wants
  // to prompt before recreating node_modules. Not CI=true: that changes many dev servers.
  env.pnpm_config_verify_deps_before_run = 'false';
  return true;
}

/**
 * Docker services see their internal container port, since `docker run -p` maps the assigned
 * host port to it; local services see the assigned host port.
 */
function injectPortEnv(env: EnvMap, service: ServiceConfig, assignment: ServiceAssignment | undefined): void {
  if (!assignment) return;
  const port = service.docker && service.port !== undefined ? service.port : assignment.port;
  for (const key of service.portEnv) {
    env[key] = String(port);
  }
}

/**
 * Compose a service's env, lowest to highest precedence: `default:` entries, process env,
 * use_env files, root config env, service env, generated PORTLER_* values. With deployment
 * precedence (production, or start) config comes first and the use_env files and process env
 * win; generated values and `port_env` stay Portler's either way.
 *
 * References resolve for `options.viewer` (default: where the service runs), so
 * `${db.address}` is a container alias inside a container and a host port on this machine.
 */
export function buildServiceEnv(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  generatedEnv: EnvMap,
  assignments: Assignments,
  options: BuildEnvOptions = {},
): ServiceEnv {
  const processEnv = options.platformEnv ?? processEnvAsMap();
  // start uses deployment precedence even without --prod, and its exports read the same value.
  const deploymentPrecedence = config.production === true || options.deploymentPrecedence === true;
  // Supplied and required keys are not resolved from config, so a reference that only
  // resolves in development cannot block the deployment's value or the required-key check.
  const required = config.production ? requiredEnvKeys(config, service) : [];
  const supplied = new Set([...Object.keys(baseEnv), ...Object.keys(processEnv)]);
  // A root key the service's env replaces is not resolved, so a reference only another
  // service can resolve cannot block this service.
  const entries = mergeEnvMaps(config.env, service.env);
  const resolveOptions = serviceResolveOptions(config, service, baseEnv, generatedEnv, assignments, options);
  const layers = resolveConfigLayers(deploymentPrecedence, entries, assignments, supplied, required, resolveOptions, options.only);
  const env: EnvMap = deploymentPrecedence
    ? { ...layers.defaults, ...layers.values, ...baseEnv, ...processEnv, ...generatedEnv, PORTLER_SERVICE_NAME: service.name }
    : { ...layers.defaults, ...processEnv, ...baseEnv, ...layers.values, ...generatedEnv, PORTLER_SERVICE_NAME: service.name };

  // In production a container gets only the keys portler.yml names for it, so one use_env file
  // can hold every secret of a deployment without each container seeing all of them.
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
 * The env top-level setup steps get, layered as in buildServiceEnv without a service.
 * The whole process env is kept, since setup steps run on this machine.
 */
export function composeProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments, generatedEnv: EnvMap = {}): ServiceEnv {
  const processEnv = processEnvAsMap();
  const required = config.production ? requiredEnvKeys(config) : [];
  const supplied = new Set([...Object.keys(baseEnv), ...Object.keys(processEnv)]);
  const options = hostResolveOptions(config, null, baseEnv, generatedEnv, assignments);
  const layers = resolveConfigLayers(config.production === true, config.env, assignments, supplied, required, options);
  const env: EnvMap = config.production
    ? { ...layers.defaults, ...layers.values, ...baseEnv, ...processEnv }
    : { ...layers.defaults, ...processEnv, ...baseEnv, ...layers.values };
  const explicitKeys = new Set([...(config.production ? required : Object.keys(baseEnv)), ...Object.keys(config.env)]);
  return { env, explicitKeys, secrets: layers.secrets };
}

/**
 * The env `portler env` prints: config values and generated values, not the shell or use_env
 * files, except where an entry yields to them (a `default:` or no value). Fills `secrets`
 * with the config's say, and by name for values taken from the shell or a use_env file.
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
  // As in buildServiceEnv, a root key the service's env replaces is not resolved.
  const layers = resolveConfigLayers(false, entries, assignments, new Set(Object.keys(supplied)), [], options);
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

// An env entry that gives the key no value: blank, or a mapping without `value` or `default`.
function isBlankConfigValue(value: unknown): boolean {
  if (!isEnvSpec(value)) return value === '' || value === null;
  const entry = envEntryValue(value);
  return entry === undefined || entry.value === '' || entry.value === null;
}

// A blank `prod.env` entry (`KEY: ''`, bare `KEY:`, `{ value: '' }`) means the deployment
// supplies the key. A metadata-only mapping keeps the lower value (mergeEnvEntry), so it is not blank.
function isLeftBlankInProd(value: unknown): boolean {
  if (!isEnvSpec(value)) return value === '' || value === null;
  const entry = envEntryValue(value);
  return entry !== undefined && (entry.value === '' || entry.value === null);
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
 * Keys the deployment must supply for a service or the project: `prod.require`, blank
 * `prod.env` entries and `required: prod`. A blank top-level entry is not required of a
 * service whose own env gives the key a value.
 */
export function requiredEnvKeys(config: PortlerConfig, service?: ServiceConfig): string[] {
  const keys = new Set([...(config.prod?.require ?? []), ...(service?.prod?.require ?? [])]);
  for (const [key, value] of Object.entries(config.prod?.env ?? {})) {
    if (!isLeftBlankInProd(value)) continue;
    if (service && Object.hasOwn(service.env, key) && !isBlankConfigValue(service.env[key])) continue;
    keys.add(key);
  }
  for (const [key, value] of Object.entries(service?.prod?.env ?? {})) {
    if (isLeftBlankInProd(value)) keys.add(key);
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
    if (isLeftBlankInProd(value) && !listed.has(key)) blank.add(key);
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
 * Throws unless every key in `required` is present and non-empty in `env`. `blank` and
 * `details.fromSpec` say which keys come from a blank `prod.env` entry or `required: prod`,
 * so the error names the line the user wrote.
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
 * The use_env file with the platform env on top. prod.require is checked against this, not
 * the final env, so a value Portler adds itself (PORTLER_*, a port_env such as PORT) cannot
 * satisfy it.
 */
export function deploymentEnv(baseEnv: EnvMap, platformEnv: EnvMap = processEnvAsMap()): EnvMap {
  return { ...baseEnv, ...platformEnv };
}

function productionMessage(config: PortlerConfig, owner: string, keys: string[], supplied: EnvMap, service?: ServiceConfig): string | undefined {
  return requiredEnvMessage(owner, keys, supplied, blankRequiredKeys(config, service), {
    fromSpec: new Set(specProductionKeys(config, service)),
    descriptions: envDescriptions(config, service),
  });
}

/**
 * Keys marked `required: true` that are missing or empty for an owner: in `effective` when
 * given, else predicted from the layer that would win. A key the deployment must supply
 * counts only the deployment's value.
 */
function missingRequiredValues(config: PortlerConfig, supplied: EnvMap, service?: ServiceConfig, effective?: EnvMap, deploymentPrecedence = config.production): string[] {
  const deploymentOnly = new Set(config.production ? requiredEnvKeys(config, service) : []);
  const missing: string[] = [];
  for (const [key, entry] of Object.entries(ownerEntries(config, service))) {
    if (!isEnvSpec(entry) || entry.required !== true) continue;
    // Unlike prod.require, required: true checks the final value, which Portler fills for these.
    if (!effective && !deploymentOnly.has(key) && service &&
      (key === 'PORTLER_SERVICE_NAME' || (service.portEnv.includes(key) && (service.port !== undefined || deploymentPrecedence)))) continue;
    // Check the winning layer, not any non-empty one: a supplied key can be empty, and in
    // dev a config value beats the shell. A composed env also catches references resolving empty.
    let value: unknown;
    if (effective) value = effective[key];
    else {
      const configured = envEntryValue(entry);
      const useSupplied = deploymentOnly.has(key) || configured === undefined || configured.isDefault || deploymentPrecedence;
      value = useSupplied && Object.hasOwn(supplied, key) ? supplied[key] : deploymentOnly.has(key) ? undefined : configured?.value;
    }
    if (value === undefined || value === null || value === '') missing.push(key);
  }
  return missing;
}

/**
 * Throws one error listing every missing env value of the project and the named services:
 * under --prod the requiredEnvKeys, in every mode `required: true` keys. A blank root
 * `prod.env` entry is required of the project only when its setup steps run, so a service
 * that sets the key itself is not blocked.
 */
export function assertEnvRequirements(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: RequirementOptions = {},
): void {
  const messages = envRequirementProblems(config, serviceNames, baseEnv, options);
  if (messages.length > 0) throw new Error(messages.join('\n'));
}

interface RequirementOptions {
  projectSetup?: boolean;
  deployment?: boolean;
  project?: boolean;
  /** Composed environments, when available, also catch references resolving to empty. */
  envs?: ReadonlyMap<string, EnvMap>;
  projectEnv?: EnvMap;
  /** start always gives the deployment precedence, even without --prod. */
  deploymentPrecedence?: boolean;
}

/**
 * What assertEnvRequirements would report, one message each; empty when nothing is missing.
 * `deployment: false` leaves out the production keys, for a caller that checks them itself (start).
 */
export function envRequirementProblems(
  config: PortlerConfig,
  serviceNames: Iterable<string>,
  baseEnv: EnvMap,
  options: RequirementOptions = {},
): string[] {
  // In dev a use_env file wins over the shell, as in buildServiceEnv.
  const supplied = config.production || options.deploymentPrecedence ? deploymentEnv(baseEnv) : { ...processEnvAsMap(), ...baseEnv };
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
  const projectMissing = projectSetup ? missingRequiredValues(config, supplied, undefined, options.projectEnv, options.deploymentPrecedence) : [];
  note('the project', projectMissing);
  for (const name of names) {
    const service = config.services[name]!;
    note(`service ${name}`, missingRequiredValues(config, supplied, service, options.envs?.get(name), options.deploymentPrecedence).filter((key) => !projectMissing.includes(key)), service);
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
 * Hide secret values and URL passwords for printing. A key is secret when `secrets` says so,
 * otherwise when its name looks like one.
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
 * What `up --prod` hands a service: its forwarded keys with the deployment's values, without
 * Portler's internal keys. Without a service, the env top-level setup sees. Fills `secrets`.
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
