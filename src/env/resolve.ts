import { didYouMean } from '../util/suggest.ts';
import type { Assignments, EnvMap, ServiceAssignment, UnknownMap } from '../types/index.ts';

type ReferenceProperty =
  | 'url'
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
  | 'name';

const REFERENCE_PROPERTIES = new Set<string>([
  'url',
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
]);

function isReferenceProperty(property: string): property is ReferenceProperty {
  return REFERENCE_PROPERTIES.has(property);
}

function assignmentValue(assignment: ServiceAssignment, property: ReferenceProperty): string {
  switch (property) {
    case 'url':
      return assignment.url;
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

function resolveReference(reference: string, assignments: Assignments): string {
  const { serviceName, property } = parseReference(reference);

  if (!isReferenceProperty(property)) {
    throw new Error(
      `unknown property "${property}" in service reference "${reference}"${didYouMean(property, REFERENCE_PROPERTIES)}. ` +
        'Valid properties: url, port, host, url_host, protocol, desired_port, container, image, name.',
    );
  }

  const assignment = assignments[serviceName];

  if (!assignment) {
    throw new Error(
      `cannot resolve "${reference}": service "${serviceName}" has no assigned port` +
        `${didYouMean(serviceName, Object.keys(assignments))}. ` +
        'Check that the service exists in portler.yml and declares a "port".',
    );
  }

  return assignmentValue(assignment, property);
}

export function resolveEnvValue(value: unknown, assignments: Assignments): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return JSON.stringify(value);

  // Bare dotted values (example.com, file.txt) stay literal. The value is
  // treated as a service reference only when the property is known OR the
  // service has an assignment, so a typo in either half (backend.prot,
  // backnd.port) raises an error instead of leaking through as a literal.
  const exactReference = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+$/.exec(value);
  if (exactReference) {
    const { serviceName, property } = parseReference(value);
    if (isReferenceProperty(property) || assignments[serviceName]) return resolveReference(value, assignments);
  }

  return value.replaceAll(/\$\{([A-Za-z0-9_-]+\.[A-Za-z0-9_]+)\}/g, (_full, reference: string) => {
    return resolveReference(reference, assignments);
  });
}

export function resolveEnvMap(env: UnknownMap, assignments: Assignments): EnvMap {
  const output: EnvMap = {};

  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid env key "${key}" (keys must start with a letter or "_" and contain only letters, digits, and "_")`);
    }
    output[key] = resolveEnvValue(value, assignments);
  }

  return output;
}
