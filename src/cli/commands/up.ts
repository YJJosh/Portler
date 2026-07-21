import { configForRunMode, loadBaseEnv, loadConfig, proxyServiceConfig, type RunMode } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { buildGeneratedEnv, buildServiceEnv, resolveEnvValue } from '../../env/index.ts';
import type { ServiceEnv } from '../../env/index.ts';
import { allocateAssignments, releasePorts } from '../../ports/index.ts';
import {
  pidInfoFor,
  readPids,
  runningServices,
  serviceLogPath,
  spawnService,
  stopServices,
  updatePids,
  waitForForegroundServices,
} from '../../process/index.ts';
import type { StopResult } from '../../process/index.ts';
import { proxyPidInfoFor, spawnProxy } from '../../proxy/index.ts';
import { waitForServiceReady } from '../../readiness/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../../state/lock.ts';
import { warnMissingVolumeSetVariants } from '../../volumes/index.ts';
import type { Assignments, PidServiceInfo, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { commandUpK8s } from './up-k8s.ts';
import { printPortTable } from '../table.ts';
import {
  dependencyLevels,
  ensureNoOverlap,
  expandAndOrderServices,
  parseRunMode,
  selectServiceNames,
  servicesNeedingReadiness,
  servicesWithPorts,
} from '../services.ts';

function validateDockerMode(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (!service.docker) {
      throw new Error(`service "${serviceName}" has no Docker config. Add image, build, dockerfile, or docker: {...}`);
    }
  }
}

function warnMissingPortEnv(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (!service.docker && service.port !== undefined && service.portEnv.length === 0) {
      process.stderr.write(
        `[portler] warning: service "${serviceName}" declares a port but no port_env, so the assigned port is not passed to its process. ` +
          `Add e.g. "port_env: PORT" to services.${serviceName} if the app reads its port from an env var.\n`,
      );
    }
  }
}

function validateCommands(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (!service.command && !service.docker) {
      throw new Error(
        `service "${serviceName}" has no "command" and no Docker config. ` +
          `Add "command: <shell command>" (or image/build/dockerfile for Docker) to services.${serviceName}.`,
      );
    }
  }
}

function validateDockerContainerNames(config: PortlerConfig): void {
  const serviceByContainer = new Map<string, string>();

  for (const service of Object.values(config.services)) {
    const containerName = service.docker?.containerName;
    if (!containerName) continue;
    const existing = serviceByContainer.get(containerName);
    if (existing) {
      throw new Error(
        `services "${existing}" and "${service.name}" both use Docker container name "${containerName}"; ` +
          'container names must be unique within a run mode',
      );
    }
    serviceByContainer.set(containerName, service.name);
  }
}

/**
 * Resolve every service reference the healthcheck will use, so typos like
 * `backend.urll` fail before any service starts instead of mid-poll.
 */
function validateHealthcheckReferences(service: ServiceConfig, assignments: Assignments): void {
  const healthcheck = service.healthcheck;
  if (!healthcheck) return;

  try {
    if (healthcheck.url) resolveEnvValue(healthcheck.url, assignments);
    if (healthcheck.command) resolveEnvValue(healthcheck.command, assignments);
  } catch (error) {
    throw new Error(`services.${service.name}.healthcheck: ${(error as Error).message}`);
  }
}

/**
 * Record one freshly spawned service (or the proxy), merging with the
 * existing file. The pids.json is rewritten after every spawn so a crash
 * mid-startup still leaves a file that `portler down` can clean up; the
 * read-merge runs under the project lock so entries written concurrently by
 * another invocation in this project survive.
 */
async function recordPidEntry(config: PortlerConfig, serviceName: string, info: PidServiceInfo): Promise<void> {
  await updatePids(config.projectDir, (pids) => {
    pids.services[serviceName] = info;
  });
}

/**
 * Teardown is allowed to fail to stop something (a pid whose identity cannot be
 * verified, a Docker container the daemon would not remove). Silence there reads
 * as "everything is down" while a service is still running and still holding its
 * port, so every path that tears down says what it left behind — and returns
 * whether the teardown was in fact incomplete, so the caller can exit non-zero
 * exactly as `down` does in the same situation.
 */
export function reportIncompleteTeardown(result: StopResult): boolean {
  if (result.unverified.length > 0) {
    process.stderr.write(
      `[portler] warning: could not stop: ${result.unverified.join(', ')} (identity not verified — see the warnings ` +
        'above). Those processes are still running and their PID entries were kept.\n',
    );
  }

  for (const failure of result.failures) {
    process.stderr.write(`[portler] warning: teardown failure: ${failure}\n`);
  }

  return result.unverified.length > 0 || result.failures.length > 0;
}

/** The teardown ran, and something it was supposed to stop is still running. */
export class IncompleteTeardownError extends Error {
  constructor(result: StopResult) {
    const stuck = [...result.unverified, ...result.failures];
    super(`did not finish stopping this run's services: ${stuck.join('; ')}`);
    this.name = 'IncompleteTeardownError';
  }
}

export interface StartOptions {
  /** Start services in the background instead of attaching to them. */
  detach: boolean;
  /** Skip already-running services instead of failing (used by restart). */
  skipRunning?: boolean;
}

/** A started stack, handed back so the caller can wait on it OUTSIDE the lifecycle lock. */
export interface StartedStack {
  children: Map<string, ReturnType<typeof spawnService>>;
  /**
   * Stop this run's services and release its ports. UNLOCKED: the caller decides
   * how to hold the lifecycle lock. Inside startPhase it runs on the
   * startup-failure path, where the lock is already held (taking it again would
   * deadlock: the lock is not reentrant); the foreground caller re-acquires it.
   */
  teardown: () => Promise<void>;
  detached: boolean;
}

/**
 * Shared start engine behind `up` and `restart`: expand the requested roots
 * to their dependencies, allocate ports, and spawn everything in dependency
 * order.
 *
 * Assumes the caller holds the project's LIFECYCLE lock — this is the
 * read-decide-write cycle it protects (read the running set, decide what to
 * start, record the pids). It deliberately does not take that lock itself, so
 * `restart` can hold one lock across its stop and its start instead of dropping
 * it in between (where a concurrent `up` could slip in).
 */
export async function startPhase(
  rawConfig: PortlerConfig,
  mode: RunMode,
  requestedRootNames: string[],
  options: StartOptions,
): Promise<StartedStack> {
  const orderedNames = expandAndOrderServices(rawConfig, requestedRootNames);
  const config = configForRunMode(rawConfig, mode);
  const runningNames = new Set(runningServices(await readPids(config.projectDir)));

  let selectedNames: string[];
  if (options.skipRunning) {
    selectedNames = orderedNames.filter((serviceName) => !runningNames.has(serviceName));
  } else {
    ensureNoOverlap(runningNames, orderedNames);
    selectedNames = orderedNames;
  }

  if (mode === 'docker') validateDockerMode(config, selectedNames);
  validateCommands(config, selectedNames);
  validateDockerContainerNames(config);

  // A proxy that is already running keeps its port and old routing targets;
  // only start (and later stop) it when it is not up yet.
  const proxy = config.proxy;
  const startProxy = proxy !== undefined && !runningNames.has(PROXY_SERVICE_NAME);


  const state = await readState(config.projectDir);
  const reserveNames = servicesWithPorts(config, selectedNames);
  if (startProxy) reserveNames.push(PROXY_SERVICE_NAME);
  const readinessNames = servicesNeedingReadiness(config, selectedNames, requestedRootNames);
  const assignments = await allocateAssignments(config, state, reserveNames, runningNames);
  const generatedEnv = buildGeneratedEnv(assignments);
  const baseEnv = await loadBaseEnv(config);

  await writeState(config.projectDir, assignments);
  await writeRuntimeEnv(config.projectDir, generatedEnv);

  printPortTable(assignments, proxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames);
  warnMissingPortEnv(config, selectedNames);
  if (config.volumeSet && config.volumes.length > 0) {
    process.stdout.write(`[portler] volume set: ${config.volumeSet}\n`);
  }
  // Fires exactly when a set variant is about to be created empty (typo guard).
  await warnMissingVolumeSetVariants(config, selectedNames);

  const stopNames = startProxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames;
  const children = new Map<string, ReturnType<typeof spawnService>>();
  // stopServices prunes its services' pids.json entries itself. It reports what
  // it could NOT stop, and a teardown that did not finish is an error: a
  // foreground `up` that exits 0 while a service it started is still running (and
  // still holding its port) tells a script the opposite of the truth — `down`
  // exits non-zero in exactly this situation. The ports are released first, so an
  // incomplete stop still gives back what it can.
  const teardown = async (): Promise<void> => {
    const result = await stopServices(config.projectDir, stopNames);
    const incomplete = reportIncompleteTeardown(result);
    const remaining = new Set(result.remaining);
    await releasePorts(
      config.projectDir,
      reserveNames.filter((serviceName) => !remaining.has(serviceName)),
    );
    if (incomplete) throw new IncompleteTeardownError(result);
  };

  try {
    // Resolve every selected service's env (and healthcheck references) up
    // front, so config mistakes like `backend.urll` fail before anything is
    // spawned instead of after some services have already started.
    const serviceEnvs = new Map<string, ServiceEnv>();
    for (const serviceName of selectedNames) {
      const service = config.services[serviceName]!;
      serviceEnvs.set(serviceName, buildServiceEnv(config, service, baseEnv, generatedEnv, assignments));
      validateHealthcheckReferences(service, assignments);
    }

    // Start level by level: services within a level are independent, so they
    // spawn together and their readiness checks run concurrently; the next
    // level only starts once the whole level is up.
    for (const level of dependencyLevels(config, selectedNames)) {
      const readinessWaits: Array<() => Promise<void>> = [];

      for (const serviceName of level) {
        const service = config.services[serviceName]!;
        const { env: serviceEnv, explicitKeys } = serviceEnvs.get(serviceName)!;
        let childExited = false;
        const logFilePath = options.detach ? serviceLogPath(config.projectDir, serviceName) : undefined;
        const child = spawnService(config, service, serviceEnv, explicitKeys, assignments[serviceName], assignments, !options.detach, logFilePath);
        child.once('exit', () => {
          childExited = true;
        });
        children.set(serviceName, child);
        if (options.detach) child.unref();

        await recordPidEntry(config, serviceName, await pidInfoFor(config, service, child, assignments[serviceName]));
        if (readinessNames.has(serviceName)) {
          readinessWaits.push(() =>
            waitForServiceReady(config, service, serviceEnv, assignments, assignments[serviceName], () => childExited),
          );
        }
      }

      const waits = readinessWaits.map((wait) => wait());
      // Pre-attach catch handlers so siblings that fail after the first
      // rejection do not become unhandled rejections; Promise.all still
      // surfaces the first failure immediately, aborting startup without
      // waiting for slower siblings to time out.
      for (const wait of waits) wait.catch(() => {});
      await Promise.all(waits);
    }

    // The proxy starts last so every routed service already listens; it
    // tolerates down targets anyway by answering 502.
    if (proxy && startProxy) {
      let proxyExited = false;
      const child = spawnProxy(proxy, assignments, !options.detach);
      child.once('exit', () => {
        proxyExited = true;
      });
      children.set(PROXY_SERVICE_NAME, child);
      if (options.detach) child.unref();

      await recordPidEntry(config, PROXY_SERVICE_NAME, await proxyPidInfoFor(config, child, assignments[PROXY_SERVICE_NAME]!));
      // The synthetic service config gives the default TCP readiness wait, so
      // the project URL below is only printed once the proxy accepts
      // connections.
      await waitForServiceReady(
        config,
        proxyServiceConfig(config, proxy),
        {},
        assignments,
        assignments[PROXY_SERVICE_NAME],
        () => proxyExited,
      );
    }
  } catch (error) {
    process.stderr.write('[portler] startup failed — stopping already-started services and releasing allocated ports\n');
    // The rollback must not replace the startup error with a cleanup error: the
    // reason the start failed is what the user needs to see. Whatever the
    // teardown could not do it has already reported for itself.
    try {
      await teardown();
    } catch (teardownError) {
      process.stderr.write(`[portler] warning: rollback was incomplete: ${(teardownError as Error).message}\n`);
    }
    throw error;
  }

  if (proxy) {
    process.stdout.write(`[portler] project url: ${assignments[PROXY_SERVICE_NAME]!.url}\n`);
  }

  if (options.detach) {
    process.stdout.write('[portler] services started in background\n');
  }

  return { children, teardown, detached: options.detach };
}

/**
 * `up`/`restart` start engine with the lifecycle lock around each DECISION.
 *
 * The foreground WAIT runs outside the lock on purpose: `portler up` in the
 * foreground lasts until the user hits Ctrl-C, and holding the lock for that
 * long would block every other command in the project — including the `portler
 * down` meant to stop it.
 *
 * The teardown that ends the wait is a decision again (stop these services,
 * prune their entries, release their ports), so it re-acquires the lock. Nothing
 * is nested: startPhase's own failure path runs while the lock is held and uses
 * the raw, unlocked teardown.
 */
export async function startServices(
  rawConfig: PortlerConfig,
  mode: RunMode,
  requestedRootNames: string[],
  options: StartOptions,
): Promise<number> {
  const stack = await withLifecycleLock(rawConfig.projectDir, () =>
    startPhase(rawConfig, mode, requestedRootNames, options),
  );

  if (stack.detached) return 0;

  return waitForForegroundServices(stack.children, () =>
    withLifecycleLockForTeardown(rawConfig.projectDir, stack.teardown),
  );
}

export async function commandUp(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  if (mode === 'k8s') {
    if (args.volumeSet !== undefined) throw new Error('--volume-set applies to Docker volumes, not "portler up k8s"');
    return commandUpK8s(args, requested);
  }

  const rawConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });
  const requestedRootNames = selectServiceNames(rawConfig, requested);
  return startServices(rawConfig, mode, requestedRootNames, { detach: args.detach });
}
