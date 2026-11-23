import { envEntryValue, isEnvSpec, mergeEnvMaps } from '../config/env-spec.ts';
import { k8sName } from '../config/naming.ts';
import { urlHostForm } from '../share/tailnet.ts';
import { didYouMean } from '../util/suggest.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig, UnknownMap } from '../types/index.ts';

/** Where the process reading a value runs (setup steps and healthcheck commands are 'host'); `address` depends on it. */
export type EnvViewer = 'host' | 'container' | 'cluster';

export interface ResolveOptions {
  /** Where the reader runs. Default: host. Without `config` every reader is treated as one on the host. */
  viewer?: EnvViewer;
  /** The service `self.*` stands for. */
  self?: string;
  /** The config the assignments belong to: needed for `address` outside the host and for exports. */
  config?: PortlerConfig;
  /** `${env.KEY}` in an export of `service`: the value (and secrecy) that service gets for KEY. Default: its config value. */
  exportEnv?: (service: string, key: string) => { value: string; secret: boolean } | undefined;
  /** Called when the value includes a secret, read through `${env.KEY}` in an export. */
  onSecret?: () => void;
  /** false while resolving the env an export reads: an export cannot read another export. */
  exports?: boolean;
  /** Internal: the export being resolved, as `service.name`. */
  exportOf?: string;
}

type ReferenceProperty =
  | 'url'
  | 'local_url'
  | 'localUrl'
  | 'port'
  | 'host'
  | 'url_host'
  | 'urlHost'
  | 'protocol'
  | 'desired_port'
  | 'desiredPort'
  | 'container'
  | 'container_name'
  | 'containerName'
  | 'image'
  | 'name'
  | 'address'
  | 'address_host'
  | 'address_port';

export const REFERENCE_PROPERTIES: ReadonlySet<string> = new Set<string>([
  'url',
  'local_url',
  'localUrl',
  'port',
  'host',
  'url_host',
  'urlHost',
  'protocol',
  'desired_port',
  'desiredPort',
  'container',
  'container_name',
  'containerName',
  'image',
  'name',
  'address',
  'address_host',
  'address_port',
]);

const PROPERTY_LIST = 'url, local_url, port, host, url_host, protocol, desired_port, container, image, name, address, address_host, address_port';

function isReferenceProperty(property: string): property is ReferenceProperty {
  return REFERENCE_PROPERTIES.has(property);
}

// KEY and CERT only as whole words (SSH_KEY, not MONKEY). Over-masking is the safe
// direction; --reveal shows the value.
const SECRET_KEY = /(SECRET|TOKEN|PASS|PWD|PRIVATE|CREDENTIAL|APIKEY|SALT|(^|_)(KEYS?|CERT)(_|$))/i;

/** Whether a key's value is hidden when printed: `secret:` on its entry decides, else its name. */
export function isSecretEnvKey(key: string, entry?: unknown): boolean {
  if (isEnvSpec(entry) && entry.secret !== undefined) return entry.secret;
  return SECRET_KEY.test(key);
}

/** The URL this machine itself reaches the service on: `url` unless the port is shared. */
export function localUrl(assignment: ServiceAssignment): string {
  if (assignment.localUrlHost === undefined) return assignment.url;
  return `${assignment.protocol}://${urlHostForm(assignment.localUrlHost)}:${assignment.port}`;
}

/** Where a service of this config runs, as a reader of env values. */
export function serviceViewer(config: PortlerConfig, service: ServiceConfig): EnvViewer {
  if (config.runMode === 'k8s') return 'cluster';
  return service.docker ? 'container' : 'host';
}

function assignmentValue(assignment: ServiceAssignment, property: Exclude<ReferenceProperty, 'address' | 'address_host' | 'address_port'>): string {
  switch (property) {
    case 'url':
      return assignment.url;
    case 'local_url':
    case 'localUrl':
      return localUrl(assignment);
    case 'port':
      return String(assignment.port);
    case 'host':
      return assignment.host;
    case 'url_host':
    case 'urlHost':
      return assignment.urlHost;
    case 'protocol':
      return assignment.protocol;
    case 'desired_port':
    case 'desiredPort':
      return assignment.desiredPort === undefined ? '' : String(assignment.desiredPort);
    case 'container':
    case 'container_name':
    case 'containerName':
      return assignment.containerName ?? '';
    case 'image':
      return assignment.image ?? '';
    case 'name':
      return assignment.name;
  }
}

function parseReference(reference: string): { serviceName: string; property: string } {
  const match = /^(?<service>[A-Za-z0-9_-]+)\.(?<property>[A-Za-z0-9_]+)$/.exec(reference);
  const serviceName = match?.groups?.service;
  const property = match?.groups?.property;

  if (!serviceName || !property) throw new Error(`invalid service reference "${reference}"`);
  return { serviceName, property };
}

function missingAssignment(reference: string, serviceName: string, assignments: Assignments): Error {
  return new Error(
    `cannot resolve "${reference}": service "${serviceName}" has no assigned port` +
      `${didYouMean(serviceName, Object.keys(assignments))}. ` +
      'Check that the service exists in portler.yml and declares a "port".',
  );
}

function addressOf(reference: string, serviceName: string, assignments: Assignments, options: ResolveOptions): { host: string; port: number } {
  const config = options.config;
  const viewer = config ? options.viewer ?? 'host' : 'host';
  const service = config?.services[serviceName];
  if (viewer === 'cluster' || (viewer === 'container' && service?.docker)) {
    if (!service) throw missingAssignment(reference, serviceName, assignments);
    if (service.port === undefined) {
      throw new Error(`cannot resolve "${reference}": service "${serviceName}" declares no port, so nothing can reach it`);
    }
    return { host: viewer === 'cluster' ? k8sName(serviceName) : serviceName, port: service.port };
  }
  const assignment = assignments[serviceName];
  if (!assignment) throw missingAssignment(reference, serviceName, assignments);
  return { host: viewer === 'container' ? 'host.docker.internal' : (assignment.localUrlHost ?? assignment.urlHost), port: assignment.port };
}

function propertyValue(reference: string, serviceName: string, property: ReferenceProperty, assignments: Assignments, options: ResolveOptions): string {
  if (property === 'address' || property === 'address_host' || property === 'address_port') {
    const { host, port } = addressOf(reference, serviceName, assignments, options);
    if (property === 'address_host') return host;
    if (property === 'address_port') return String(port);
    return `${host.includes(':') ? `[${host}]` : host}:${port}`;
  }
  // A service's name needs no port.
  if (property === 'name' && options.config?.services[serviceName]) return serviceName;
  const assignment = assignments[serviceName];
  if (!assignment) throw missingAssignment(reference, serviceName, assignments);
  return assignmentValue(assignment, property);
}

// The value from portler.yml alone, without the shell or use_env files.
function configEnvValue(config: PortlerConfig, serviceName: string, key: string, assignments: Assignments, options: ResolveOptions) {
  const service = config.services[serviceName]!;
  const merged = mergeEnvMaps(config.env, service.env);
  if (!Object.hasOwn(merged, key)) return undefined;
  const entry = envEntryValue(merged[key]);
  if (entry === undefined) return undefined;
  const value = resolveEnvValue(entry.value, assignments, {
    config,
    viewer: serviceViewer(config, service),
    self: serviceName,
    exports: false,
  });
  return { value, secret: isSecretEnvKey(key, merged[key]) };
}

function exportEnvValue(reference: string, key: string, assignments: Assignments, options: ResolveOptions): string {
  if (options.exportOf === undefined) {
    throw new Error(`"${reference}" only works inside a service's exports, where it reads that service's own env`);
  }
  const exporter = options.exportOf.split('.', 1)[0]!;
  const found = options.exportEnv
    ? options.exportEnv(exporter, key)
    : options.config
      ? configEnvValue(options.config, exporter, key, assignments, options)
      : undefined;
  if (found === undefined) throw new Error(`export "${options.exportOf}" reads env.${key}, but service "${exporter}" has no env value for ${key}`);
  if (found.secret) options.onSecret?.();
  return found.value;
}

function resolveReference(reference: string, assignments: Assignments, options: ResolveOptions): string {
  const { serviceName: written, property } = parseReference(reference);
  if (written === 'env') return exportEnvValue(reference, property, assignments, options);
  if (written === 'self' && options.self === undefined) {
    throw new Error(`cannot resolve "${reference}": "self" only works in a service's own env, healthcheck, setup or exports`);
  }
  const serviceName = written === 'self' ? options.self! : written;

  if (isReferenceProperty(property)) return propertyValue(reference, serviceName, property, assignments, options);

  const exports = options.config?.services[serviceName]?.exports;
  if (exports && Object.hasOwn(exports, property)) {
    const name = `${serviceName}.${property}`;
    if (options.exportOf !== undefined) throw new Error(`export "${options.exportOf}" cannot use another export ("${name}")`);
    if (options.exports === false) {
      throw new Error(`cannot resolve "${reference}": an export cannot read an env value that uses an export ("${name}")`);
    }
    try {
      return resolveEnvValue(exports[property], assignments, { ...options, self: serviceName, exportOf: name });
    } catch (error) {
      throw new Error(`in export "${name}": ${(error as Error).message}`);
    }
  }

  const exportNames = exports ? Object.keys(exports) : [];
  throw new Error(
    `unknown property "${property}" in service reference "${reference}"${didYouMean(property, [...REFERENCE_PROPERTIES, ...exportNames])}. ` +
      `Valid properties: ${PROPERTY_LIST}${exportNames.length > 0 ? `; exports of ${serviceName}: ${exportNames.join(', ')}` : ''}.`,
  );
}

function isBareReference(serviceName: string, property: string, assignments: Assignments, options: ResolveOptions): boolean {
  if (serviceName === 'env') return options.exportOf !== undefined;
  if (serviceName === 'self' || isReferenceProperty(property) || assignments[serviceName]) return true;
  const exports = options.config?.services[serviceName]?.exports;
  return exports !== undefined && Object.hasOwn(exports, property);
}

export function resolveEnvValue(value: unknown, assignments: Assignments, options: ResolveOptions = {}): string {
  if (isEnvSpec(value)) return resolveEnvValue(envEntryValue(value)?.value, assignments, options);
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return JSON.stringify(value);

  // A bare `a.b` (example.com) stays literal unless the property is known or the service
  // is assigned, so a typo in only one half (backnd.port) is an error, not a literal.
  const exactReference = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/.exec(value);
  if (exactReference) {
    const { serviceName, property } = parseReference(value);
    if (isBareReference(serviceName, property, assignments, options)) return resolveReference(value, assignments, options);
  }

  return value.replaceAll(/\$\{([A-Za-z0-9_-]+\.[A-Za-z0-9_]+)\}/g, (_full, reference: string) => {
    return resolveReference(reference, assignments, options);
  });
}

/**
 * Keys in `skip` are validated but not resolved or returned, so a value that never applies cannot fail on a dangling reference.
 * Entries without a value are left out; `secrets` collects keys whose value read a secret through an export.
 */
export function resolveEnvMap(
  env: UnknownMap,
  assignments: Assignments,
  skip?: ReadonlySet<string>,
  options: ResolveOptions = {},
  secrets?: Set<string>,
): EnvMap {
  const output: EnvMap = {};

  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid env key "${key}" (keys must start with a letter or "_" and contain only letters, digits, and "_")`);
    }
    if (skip?.has(key)) continue;
    const entry = envEntryValue(value);
    if (entry === undefined) continue;
    output[key] = resolveEnvValue(entry.value, assignments, secrets ? { ...options, onSecret: () => secrets.add(key) } : options);
  }

  return output;
}
