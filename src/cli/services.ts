import type { RunMode } from '../config/index.ts';
import { PROXY_SERVICE_NAME } from '../constants.ts';
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
/** Docker mode needs Docker config for every selected service. */
export function validateDockerMode(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (!service.docker) {
      throw new Error(`service "${serviceName}" has no Docker config. Add image, build, dockerfile, or docker: {...}`);
    }
  }
}

/**
 * Refuse to start a service that is already running. `alternative`, when given, is a
 * command that does what the user most likely wanted instead (restart for local and
 * Docker stacks), offered before the `down` that clears the way for a fresh `up`.
 */
export function ensureNoOverlap(
  runningNames: ReadonlySet<string>,
  selectedNames: string[],
  alternative?: string,
  alternativeNote?: string,
): void {
  const running = selectedNames.filter((serviceName) => runningNames.has(serviceName));

  if (running.length > 0) {
    const down = `"portler down ${running.join(' ')}"`;
    throw new Error(
      alternative
        ? `already running: ${running.join(', ')}. To (re)start services next to what is running, use "${alternative}"${alternativeNote ? ` (${alternativeNote})` : ''}; to start over, use ${down} first.`
        : `already running: ${running.join(', ')}. Use ${down} first.`,
    );
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
 * Like selectServiceNames, but also accepts "proxy" when the config has a
 * proxy block: the proxy is not a service, yet `down proxy` and `ps proxy`
 * should reach it.
 */
export function selectServiceTargets(config: PortlerConfig, requested: string[]): string[] {
  const services = requested.filter((name) => !(name === PROXY_SERVICE_NAME && config.proxy));
  if (services.length > 0) selectServiceNames(config, services);
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

/** Say which services run from a pinned `--image`, and whether that skipped a build. */
export function reportImageOverrides(modeConfig: PortlerConfig, images: Readonly<Record<string, string>>): void {
  for (const [serviceName, image] of Object.entries(images)) {
    const hadBuild = modeConfig.services[serviceName]?.docker?.build !== undefined;
    process.stdout.write(`[portler] ${serviceName}: using image ${image}${hadBuild ? ' (build skipped)' : ''}\n`);
  }
}

/**
 * Every `--image` target has to be a service this command actually starts. `up api` and
 * `restart api` leave an already-running dependency untouched, and a service outside the
 * selection is never started at all; in both cases the flag would be accepted and change
 * nothing, so the old image keeps running while the user believes it was replaced.
 */
export function validateImageOverrideTargets(
  images: Readonly<Record<string, string>>,
  selectedNames: readonly string[],
  runningNames: ReadonlySet<string>,
): void {
  const selected = new Set(selectedNames);
  for (const serviceName of Object.keys(images)) {
    if (selected.has(serviceName)) continue;
    if (runningNames.has(serviceName)) {
      throw new Error(
        `--image: service "${serviceName}" is already running and this command leaves it running, so it would keep its ` +
          `current image. Include it in the restart, or stop it first with "portler down ${serviceName}".`,
      );
    }
    throw new Error(
      `--image: service "${serviceName}" is not started by this command, so the image would never be used. ` +
        'Name it, or a service that depends on it, in the command.',
    );
  }
}
