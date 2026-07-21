import { isObject, optionalString } from './scalars.ts';
import type { DependencyConfig, DependencyCondition, ServiceConfig } from '../types/index.ts';

function normalizeDependencyCondition(value: string, serviceName: string, dependencyName: string): DependencyCondition {
  if (value === 'started') return 'started';
  if (value === 'ready' || value === 'healthy' || value === 'service_healthy') return 'ready';
  throw new Error(`services.${serviceName}.depends_on.${dependencyName}.condition must be started or ready`);
}

export function normalizeDependsOn(value: unknown, serviceName: string): DependencyConfig[] {
  if (value === undefined || value === null) return [];

  if (typeof value === 'string') {
    return [{ service: value, condition: 'ready' }];
  }

  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) {
      throw new Error(`services.${serviceName}.depends_on array must only contain service names`);
    }
    return value.map((dependency) => ({ service: dependency, condition: 'ready' }));
  }

  if (!isObject(value)) throw new Error(`services.${serviceName}.depends_on must be a string, array, or object`);

  return Object.entries(value).map(([dependencyName, rawDependency]) => {
    if (rawDependency === null || rawDependency === undefined || rawDependency === true) {
      return { service: dependencyName, condition: 'ready' };
    }

    if (typeof rawDependency === 'string') {
      return { service: dependencyName, condition: normalizeDependencyCondition(rawDependency, serviceName, dependencyName) };
    }

    if (isObject(rawDependency)) {
      const condition = optionalString(rawDependency.condition, `services.${serviceName}.depends_on.${dependencyName}.condition`);
      return {
        service: dependencyName,
        condition: condition ? normalizeDependencyCondition(condition, serviceName, dependencyName) : 'ready',
      };
    }

    throw new Error(`services.${serviceName}.depends_on.${dependencyName} must be a string or object`);
  });
}

/**
 * Find a depends_on cycle among the services, returned as the path of
 * service names with the starting service repeated at the end (a -> b -> a),
 * or null when the dependency graph is acyclic.
 */
export function findDependencyCycle(services: Record<string, ServiceConfig>): string[] | null {
  const settled = new Set<string>();

  const visit = (serviceName: string, path: string[]): string[] | null => {
    if (settled.has(serviceName)) return null;

    const seenAt = path.indexOf(serviceName);
    if (seenAt !== -1) return [...path.slice(seenAt), serviceName];

    const service = services[serviceName];
    if (!service) return null;

    for (const dependency of service.dependsOn) {
      const cycle = visit(dependency.service, [...path, serviceName]);
      if (cycle) return cycle;
    }

    settled.add(serviceName);
    return null;
  };

  for (const serviceName of Object.keys(services)) {
    const cycle = visit(serviceName, []);
    if (cycle) return cycle;
  }

  return null;
}
