import type { RunMode } from '../config/index.ts';
import { didYouMean } from '../util/suggest.ts';
import type { PortlerConfig } from '../types/index.ts';

/**
 * Strip the optional leading 'docker'/'k8s' mode token shared by `up` and
 * `down`. The loader rejects services named "docker" and "k8s", so the tokens
 * cannot collide with real service names.
 */
export function parseRunMode(positionals: string[]): { mode: RunMode; requested: string[] } {
  if (positionals[0] === 'docker') {
    return { mode: 'docker', requested: positionals.slice(1) };
  }

  if (positionals[0] === 'k8s') {
    return { mode: 'k8s', requested: positionals.slice(1) };
  }

  return { mode: 'local', requested: positionals };
}

/** Refuse to start services that already have a live pids.json entry. */
export function ensureNoOverlap(runningNames: ReadonlySet<string>, selectedNames: string[]): void {
  const running = selectedNames.filter((serviceName) => runningNames.has(serviceName));

  if (running.length > 0) {
    throw new Error(`already running: ${running.join(', ')}. Use "portler down ${running.join(' ')}" first.`);
  }
}

/** Validate and resolve the user-requested service names (defaulting to all). */
export function selectServiceNames(config: PortlerConfig, requested: string[]): string[] {
  if (requested.length === 0) return Object.keys(config.services);

  const known = Object.keys(config.services);

  for (const serviceName of requested) {
    if (!config.services[serviceName]) {
      throw new Error(`unknown service "${serviceName}"${didYouMean(serviceName, known)}. Available services: ${known.join(', ')}.`);
    }
  }

  return requested;
}

/**
 * Expand the requested roots to include their dependencies and return them in
 * dependency-first (topological) start order. Throws on dependency cycles.
 */
export function expandAndOrderServices(config: PortlerConfig, requested: string[]): string[] {
  const roots = selectServiceNames(config, requested);
  const order: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (serviceName: string): void => {
    if (visited.has(serviceName)) return;
    if (visiting.has(serviceName)) throw new Error(`dependency cycle includes service "${serviceName}"`);

    const service = config.services[serviceName];
    if (!service) throw new Error(`unknown service "${serviceName}"`);

    visiting.add(serviceName);
    for (const dependency of service.dependsOn) {
      visit(dependency.service);
    }
    visiting.delete(serviceName);
    visited.add(serviceName);
    order.push(serviceName);
  };

  for (const serviceName of roots) visit(serviceName);
  return order;
}

/**
 * Group the (topologically ordered) services into dependency levels: level 0
 * has no selected dependencies, level N+1 depends only on levels <= N.
 * Services within a level are independent and can start concurrently.
 */
export function dependencyLevels(config: PortlerConfig, orderedNames: string[]): string[][] {
  const levelByName = new Map<string, number>();
  const levels: string[][] = [];

  for (const serviceName of orderedNames) {
    const service = config.services[serviceName]!;
    let level = 0;
    for (const dependency of service.dependsOn) {
      const dependencyLevel = levelByName.get(dependency.service);
      if (dependencyLevel !== undefined) level = Math.max(level, dependencyLevel + 1);
    }
    levelByName.set(serviceName, level);
    (levels[level] ??= []).push(serviceName);
  }

  return levels;
}

/** Filter the given service names down to those that declare a port. */
export function servicesWithPorts(config: PortlerConfig, serviceNames: string[]): string[] {
  return serviceNames.filter((serviceName) => config.services[serviceName]?.port !== undefined);
}

/**
 * Determine which services need a readiness wait: every dependency requested
 * with the `ready` condition, every service with an explicit healthcheck, and
 * requested roots that expose a port.
 */
export function servicesNeedingReadiness(config: PortlerConfig, serviceNames: string[], rootNames: string[]): Set<string> {
  const names = new Set<string>();
  const roots = new Set(rootNames);

  for (const serviceName of serviceNames) {
    const service = config.services[serviceName]!;
    for (const dependency of service.dependsOn) {
      if (dependency.condition === 'ready') names.add(dependency.service);
    }
    if (service.healthcheck || (roots.has(serviceName) && service.port !== undefined)) names.add(serviceName);
  }

  return names;
}
