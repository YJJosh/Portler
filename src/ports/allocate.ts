import { proxyServiceConfig } from '../config/index.ts';
import { fnv1a } from '../util/hash.ts';
import { isPort } from '../util/guards.ts';
import { CorruptStateFileError } from '../util/json-file.ts';
import { withRegistryLock } from './lock.ts';
import { isPortFree } from './probe.ts';
import { pruneRegistry, readRegistry, writeRegistry } from './registry.ts';
import type { Assignments, PortlerConfig, RegistryFile, ServiceAssignment, ServiceConfig, StateFile } from '../types/index.ts';

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function serviceUrl(service: ServiceConfig, port: number): string {
  return `${service.protocol}://${formatHostForUrl(service.urlHost)}:${port}`;
}

function makeAssignment(service: ServiceConfig, port: number): ServiceAssignment {
  return {
    name: service.name,
    port,
    desiredPort: service.port,
    host: service.host,
    urlHost: service.urlHost,
    protocol: service.protocol,
    url: serviceUrl(service, port),
    containerName: service.docker?.containerName,
    image: service.docker?.image,
  };
}

/**
 * Every service that declares a port, plus the synthetic proxy service when a
 * `proxy:` block exists (the proxy always needs a port, even with
 * `port: auto`).
 */
function servicesToAllocate(config: PortlerConfig): ServiceConfig[] {
  const services = Object.values(config.services).filter((service) => service.port !== undefined);
  if (config.proxy) services.push(proxyServiceConfig(config, config.proxy));
  return services;
}

async function choosePort(
  config: PortlerConfig,
  service: ServiceConfig,
  state: StateFile | null,
  reservedPorts: Set<number>,
  ownRegisteredPort?: number,
): Promise<number> {
  // Reclaim the service's own previous registry port when it is still free.
  //
  // The reservedPorts check is essential: reservedPorts also holds the ports
  // handed out EARLIER IN THIS VERY LOOP. Without it, two services of the same
  // project restarting together can both land on one port — service A's stale
  // registry entry is dropped (it is being reserved), A's port is therefore not
  // in reservedPorts initially, service B probes and picks it (nothing is bound
  // yet, so it reads as free), and then A's own-port reclaim hands A the same
  // port because nothing is listening on it either. Both then race to bind.
  if (
    ownRegisteredPort !== undefined &&
    isPort(ownRegisteredPort) &&
    !reservedPorts.has(ownRegisteredPort) &&
    (await isPortFree(ownRegisteredPort, service.host))
  ) {
    return ownRegisteredPort;
  }

  const candidates: number[] = [];
  const previous = state?.services?.[service.name]?.port;

  // A preferred declared port beats the previous assignment: the service
  // (or the proxy with an explicit port) should return to its declared home
  // once it frees up, instead of sticking to a drifted port forever.
  if (service.preferDeclaredPort && service.port !== undefined) candidates.push(service.port);
  if (previous !== undefined) candidates.push(previous);

  for (const candidate of candidates) {
    if (!isPort(candidate)) continue;
    if (reservedPorts.has(candidate)) continue;
    if (await isPortFree(candidate, service.host)) return candidate;
  }

  const { start, end } = config.portRange;
  const size = end - start + 1;
  // Hash-derived scan offset: gives each (project, service) a stable home in
  // the range so different projects spread out instead of all contending for
  // the ports at the start of the range.
  const offset = fnv1a(`${config.projectDir}:${service.name}`) % size;

  for (let attempt = 0; attempt < size; attempt += 1) {
    const port = start + ((offset + attempt) % size);
    if (reservedPorts.has(port)) continue;
    if (await isPortFree(port, service.host)) return port;
  }

  throw new Error(`no free ports available in range ${start}-${end}`);
}

/**
 * Assign a free localhost port to every service that declares one, reusing
 * prior assignments where possible and recording reservations in the global
 * registry for the services named in `reserveServices`.
 *
 * `runningServiceNames` are this project's services with a live process:
 * their recorded port is reused verbatim (it is busy precisely because they
 * listen on it), never re-probed. Callers must NOT include them in
 * `reserveServices`, since reserving deletes the registry entry and
 * re-probes.
 */
export async function allocateAssignments(
  config: PortlerConfig,
  state: StateFile | null,
  reserveServices: string[],
  runningServiceNames: ReadonlySet<string>,
): Promise<Assignments> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    await pruneRegistry(registry);

    const reserveSet = new Set(reserveServices);

    // Ports this project's services currently hold in the registry — for
    // services we are not (re)starting these are likely in active use and
    // must be reused verbatim, not re-probed.
    const ownPorts = new Map<string, number>();
    for (const entry of Object.values(registry.ports)) {
      if (entry.project === config.projectDir) ownPorts.set(entry.service, entry.port);
    }

    // Drop the reserved services' own entries so choosePort can reclaim their
    // previous ports (the callers guarantee those services are not running).
    for (const [portText, entry] of Object.entries(registry.ports)) {
      if (entry.project === config.projectDir && reserveSet.has(entry.service)) {
        delete registry.ports[portText];
      }
    }

    const reservedPorts = new Set<number>();
    for (const portText of Object.keys(registry.ports)) {
      const port = Number.parseInt(portText, 10);
      if (Number.isInteger(port)) reservedPorts.add(port);
    }

    const assignments: Assignments = {};
    const allocatable = servicesToAllocate(config);

    // Every service with a port gets an assignment — even unselected ones —
    // because selected services may reference them (${other.port}) and
    // state.json must stay complete. Only reserveServices get registry
    // entries below.
    //
    // Pass 1: verbatim reuse for RUNNING services we are not (re)starting —
    // their port is busy precisely because they listen on it, so probing
    // would wrongly move them.
    for (const service of allocatable) {
      if (reserveSet.has(service.name) || !runningServiceNames.has(service.name)) continue;

      const statePort = state?.services?.[service.name]?.port;
      const port = ownPorts.get(service.name) ?? (statePort !== undefined && isPort(statePort) ? statePort : undefined);
      if (port === undefined) continue;

      assignments[service.name] = makeAssignment(service, port);
      reservedPorts.add(port);
    }

    // Pass 2: probe for everything else — services being started, and
    // stopped services whose recorded port may have been taken by a foreign
    // process in the meantime.
    for (const service of allocatable) {
      if (assignments[service.name]) continue;
      const port = await choosePort(config, service, state, reservedPorts, ownPorts.get(service.name));
      assignments[service.name] = makeAssignment(service, port);
      reservedPorts.add(port);
    }

    for (const serviceName of reserveSet) {
      const assignment = assignments[serviceName];
      if (!assignment) continue;

      registry.ports[String(assignment.port)] = {
        project: config.projectDir,
        service: serviceName,
        port: assignment.port,
        desiredPort: assignment.desiredPort,
        host: assignment.host,
        assignedAt: new Date().toISOString(),
      };
    }

    await writeRegistry(registry);
    return assignments;
  });
}

/**
 * Prune stale entries (any project) from the global registry: entries whose
 * port is free again and whose reservation is old enough that no concurrent
 * `up` can still be binding it. Returns the number of entries removed.
 */
export async function pruneGlobalRegistry(force = false): Promise<number> {
  return withRegistryLock(async () => {
    let registry: RegistryFile;
    try {
      registry = await readRegistry();
    } catch (error) {
      if (!force || !(error instanceof CorruptStateFileError)) throw error;

      // Keep recovery in this lock acquisition. Releasing after the failed read
      // and reacquiring just to reset would leave a needless race window between
      // the decision that the registry is corrupt and its replacement.
      process.stderr.write(
        '[portler] warning: reset the corrupt global port registry because --global --force was specified. ' +
          'Any in-flight, not-yet-bound reservation was discarded; active listening ports will still be detected by probing.\n',
      );
      registry = { version: 1, ports: {} };
    }

    const before = Object.keys(registry.ports).length;
    await pruneRegistry(registry);
    await writeRegistry(registry);
    return before - Object.keys(registry.ports).length;
  });
}

/** Remove this project's registry reservations (optionally only some services). */
export async function releasePorts(projectDir: string, serviceNames?: string[]): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await readRegistry();
    const serviceSet = serviceNames ? new Set(serviceNames) : null;

    for (const [portText, entry] of Object.entries(registry.ports)) {
      if (entry.project !== projectDir) continue;
      if (serviceSet && !serviceSet.has(entry.service)) continue;
      delete registry.ports[portText];
    }

    await writeRegistry(registry);
  });
}
