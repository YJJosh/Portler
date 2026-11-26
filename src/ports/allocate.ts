import { proxyServiceConfig } from '../config/index.ts';
import { fnv1a } from '../util/hash.ts';
import { isPort } from '../util/guards.ts';
import { CorruptStateFileError } from '../util/json-file.ts';
import { withRegistryLock } from './lock.ts';
import { isPortFree } from './probe.ts';
import { serviceTransport } from './transport.ts';
import { pruneRegistry, readRegistry, writeRegistry } from './registry.ts';
import type { Assignments, PidServiceInfo, PortlerConfig, RegistryFile, ServiceAssignment, ServiceConfig, StateFile } from '../types/index.ts';

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

function serviceUrl(service: ServiceConfig, port: number): string {
  return `${service.protocol}://${formatHostForUrl(service.urlHost)}:${port}`;
}

function makeAssignment(service: ServiceConfig, port: number): ServiceAssignment {
  const transport = serviceTransport(service);
  return {
    name: service.name,
    port,
    desiredPort: service.port,
    host: service.host,
    urlHost: service.urlHost,
    ...(service.localUrlHost !== undefined ? { localUrlHost: service.localUrlHost } : {}),
    protocol: service.protocol,
    url: serviceUrl(service, port),
    ...(transport === 'tcp' ? {} : { transport }),
    containerName: service.docker?.containerName,
    image: service.docker?.image,
  };
}

function servicesToAllocate(config: PortlerConfig): ServiceConfig[] {
  const services = Object.values(config.services).filter((service) => service.port !== undefined);
  if (config.proxy) services.push(proxyServiceConfig(config, config.proxy));
  return services;
}

// A shared port also needs the shared addresses free: the service's forwarder listens there.
async function isFreeFor(config: PortlerConfig, service: ServiceConfig, port: number): Promise<boolean> {
  if (!(await isPortFree(port, service.host, serviceTransport(service)))) return false;
  if (!config.share || service.localUrlHost === undefined) return true;
  for (const address of config.share.addresses) {
    if (!(await isPortFree(port, address, 'tcp'))) return false;
  }
  return true;
}

async function choosePort(
  config: PortlerConfig,
  service: ServiceConfig,
  state: StateFile | null,
  reservedPorts: Set<number>,
  ownRegisteredPort?: number,
): Promise<number> {
  // reservedPorts includes ports handed out earlier in this loop. Nothing is bound
  // yet, so without it two services restarting together could get the same port.
  if (
    ownRegisteredPort !== undefined &&
    isPort(ownRegisteredPort) &&
    !reservedPorts.has(ownRegisteredPort) &&
    (await isFreeFor(config, service, ownRegisteredPort))
  ) {
    return ownRegisteredPort;
  }

  const candidates: number[] = [];
  const previous = state?.services?.[service.name]?.port;

  // A preferred declared port beats the previous one, so a drifted service returns home once it frees up.
  if (service.preferDeclaredPort && service.port !== undefined) candidates.push(service.port);
  if (previous !== undefined) candidates.push(previous);

  for (const candidate of candidates) {
    if (!isPort(candidate)) continue;
    if (reservedPorts.has(candidate)) continue;
    if (await isFreeFor(config, service, candidate)) return candidate;
  }

  const { start, end } = config.portRange;
  const size = end - start + 1;
  // A stable per-service offset, so projects spread out instead of contending for the start of the range.
  const offset = fnv1a(`${config.projectDir}:${service.name}`) % size;

  for (let attempt = 0; attempt < size; attempt += 1) {
    const port = start + ((offset + attempt) % size);
    if (reservedPorts.has(port)) continue;
    if (await isFreeFor(config, service, port)) return port;
  }

  throw new Error(`no free ports available in range ${start}-${end}`);
}

/** Assigns every declared port; only `reserveServices` get registry entries and are re-probed, so never list
 * `runningServiceNames` there (they keep their port unprobed). `options.recorded` (pids.json) is the last port fallback. */
export async function allocateAssignments(
  config: PortlerConfig,
  state: StateFile | null,
  reserveServices: string[],
  runningServiceNames: ReadonlySet<string>,
  options: { signal?: AbortSignal; recorded?: Readonly<Record<string, Pick<PidServiceInfo, 'port'>>> } = {},
): Promise<Assignments> {
  return withRegistryLock(async () => {
    const registry = await readRegistry();
    await pruneRegistry(registry);

    const reserveSet = new Set(reserveServices);

    const ownPorts = new Map<string, number>();
    for (const entry of Object.values(registry.ports)) {
      if (entry.project === config.projectDir) ownPorts.set(entry.service, entry.port);
    }

    // So choosePort can reclaim them; callers guarantee these services are not running.
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

    // Unselected running services get an assignment too: others may reference
    // ${other.port}, and state.json must stay complete.
    for (const service of allocatable) {
      if (reserveSet.has(service.name) || !runningServiceNames.has(service.name)) continue;

      const statePort = state?.services?.[service.name]?.port;
      const recordedPort = options.recorded?.[service.name]?.port;
      const port =
        ownPorts.get(service.name) ??
        (statePort !== undefined && isPort(statePort) ? statePort : undefined) ??
        (recordedPort !== undefined && isPort(recordedPort) ? recordedPort : undefined);
      if (port === undefined) continue;

      assignments[service.name] = makeAssignment(service, port);
      reservedPorts.add(port);
    }

    // A stopped service's recorded port may have been taken meanwhile, so it is probed.
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
        ...(assignment.transport === undefined ? {} : { transport: assignment.transport }),
        assignedAt: new Date().toISOString(),
      };
    }

    await writeRegistry(registry);
    return assignments;
  }, { signal: options.signal });
}

/** Prunes every project's stale entries; returns how many. With `force`, a corrupt registry is reset instead of throwing. */
export async function pruneGlobalRegistry(force = false): Promise<number> {
  return withRegistryLock(async () => {
    let registry: RegistryFile;
    try {
      registry = await readRegistry();
    } catch (error) {
      if (!force || !(error instanceof CorruptStateFileError)) throw error;

      // Reset under the same lock, so nothing can write between the failed read and the reset.
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
