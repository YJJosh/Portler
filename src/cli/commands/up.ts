import { applyImageOverrides, configForRunMode, loadBaseEnv, loadConfig, proxyServiceConfig, type RunMode } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { buildProjectEnv, pruneSetupReceipts, runSetupStep } from '../../setup/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertProductionRequirements, buildGeneratedEnv, buildServiceEnv, resolveEnvValue } from '../../env/index.ts';
import type { ServiceEnv } from '../../env/index.ts';
import { allocateAssignments, releasePorts } from '../../ports/index.ts';
import {
  identityVerdict,
  isPidAlive,
  ownedContainerLiveness,
  pidInfoFor,
  readPids,
  readProcessStartToken,
  runningServices,
  serviceLogPath,
  spawnService,
  stopServices,
  updatePids,
  waitForForegroundServices,
} from '../../process/index.ts';
import type { ForegroundTeardownOptions, StopResult } from '../../process/index.ts';
import { proxyPidInfoFor, spawnProxy } from '../../proxy/index.ts';
import { DOCKER_TCP_HOLD_MS, logLocationHint, waitForServiceReady } from '../../readiness/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../../state/lock.ts';
import { warnMissingVolumeSetVariants } from '../../volumes/index.ts';
import type { Assignments, PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { commandUpK8s } from './up-k8s.ts';
import { printPortTable } from '../table.ts';
import {
  dependencyLevels,
  ensureNoOverlap,
  expandAndOrderServices,
  parseRunMode,
  reportImageOverrides,
  selectServiceNames,
  servicesNeedingReadiness,
  servicesWithPorts,
  validateDockerMode,
  validateImageOverrideTargets,
} from '../services.ts';

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
  prod?: boolean;
  setup?: boolean;
  /** Start services in the background instead of attaching to them. */
  detach: boolean;
  /** Skip already-running services instead of failing (used by restart). */
  skipRunning?: boolean;
  /** `--image <service>=<image>`: run these Docker services from pinned images instead of building them. */
  images?: Readonly<Record<string, string>>;
}

/** A started stack, handed back so the caller can wait on it OUTSIDE the lifecycle lock. */
export interface StartedStack {
  children: Map<string, ReturnType<typeof spawnService>>;
  /**
   * Stop this run's services and release its ports. UNLOCKED: the caller decides
   * how to hold the lifecycle lock. Inside startPhase it runs on the
   * startup-failure path, where the lock is already held (taking it again would
   * deadlock: the lock is not reentrant); the foreground caller re-acquires it.
   * Returns this run's own services it left running because a service another
   * run started depends on them; `keepAdopted: false` stops those too.
   */
  teardown: (options?: ForegroundTeardownOptions) => Promise<string[]>;
  /**
   * Whether every service another run started, the reason the last teardown
   * kept something, is still alive. Those are not this run's children, so
   * nothing reports their exit: the supervisor asks this while it stays
   * attached, and the first one to go means another pass.
   */
  dependentsAlive: () => Promise<boolean>;
  detached: boolean;
}

type EntryLiveness = { status: 'alive' | 'unknown'; reason: string } | { status: 'dead' };

/**
 * Whether a pids.json entry still names something alive. The pid first, by
 * identity: a live pid whose start token differs from the recorded one was
 * recycled by the OS for an unrelated process, so the entry is as dead as one
 * whose pid is gone or a zombie. A live pid
 * that cannot be identified (no recorded token, or the platform will not say)
 * counts as alive. Then, for a Docker service, its container: `docker run` is
 * supervised by a shell whose pid can be gone while the container runs on, and
 * handing such an entry to stopServices would remove a container that another
 * run is serving through. An entry whose container cannot be inspected (daemon
 * down, permission error) is 'unknown' and treated as alive: guessing "dead" is
 * the one mistake that destroys something.
 */
async function entryLiveness(projectDir: string, info: PidServiceInfo): Promise<EntryLiveness> {
  // A zombie counts as gone. Under a PID 1 that does not reap orphans (a
  // container without an init), a replacement that exited keeps its pid and its
  // start token, and the existence check alone would keep it, and everything it
  // depends on, alive for good.
  const exists = isPidAlive(info.pid);
  const verdict = identityVerdict(info.startToken, exists ? await readProcessStartToken(info.pid) : null, exists);
  if (verdict === 'match' || verdict === 'unverifiable') return { status: 'alive', reason: 'its PID entry belongs to another run' };
  if (!info.dockerContainer) return { status: 'dead' };
  const container = await ownedContainerLiveness(info.dockerContainer, projectDir);
  if (container.status === 'running') {
    return { status: 'alive', reason: `its container "${info.dockerContainer}" is still running under another run` };
  }
  if (container.status === 'error') {
    return { status: 'unknown', reason: `its container "${info.dockerContainer}" could not be inspected (${container.message})` };
  }
  return { status: 'dead' };
}

/**
 * Every service the given PID entries depend on, transitively, as each entry
 * recorded when it started: what a service actually runs with, whichever
 * portler.yml a run read. An entry written by an older Portler has no record;
 * its dependencies come from the config as it is on disk now, the nearest
 * thing to what started it, and a file that no longer loads means none.
 */
async function recordedDependencyClosure(config: PortlerConfig, pids: PidsFile, roots: string[]): Promise<Set<string>> {
  let fallback: PortlerConfig | null | undefined;
  const dependenciesOf = async (serviceName: string): Promise<string[]> => {
    const recorded = pids.services[serviceName]?.dependsOn;
    if (recorded) return recorded;
    if (fallback === undefined) {
      try {
        fallback = await loadConfig(config.projectDir, config.filePath, { volumeSet: config.volumeSet });
      } catch {
        fallback = null;
      }
    }
    return fallback?.services[serviceName]?.dependsOn.map((dependency) => dependency.service) ?? [];
  };
  const closure = new Set<string>();
  const queue = [...roots];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const dependency of await dependenciesOf(next)) {
      if (closure.has(dependency)) continue;
      closure.add(dependency);
      queue.push(dependency);
    }
  }
  return closure;
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
  // Under --prod only prod.services run; dependencies on left-out services are dropped.
  const raw = productionServices(rawConfig, options.prod);
  const orderedNames = expandAndOrderServices(raw, requestedRootNames);
  const modeConfig = configForRunMode(raw, mode);
  const images = options.images ?? {};
  const config = applyProduction(applyImageOverrides(modeConfig, images), options.prod);
  const pidsBefore = await readPids(config.projectDir);
  const runningNames = new Set(runningServices(pidsBefore));

  let selectedNames: string[];
  if (options.skipRunning) {
    selectedNames = orderedNames.filter((serviceName) => !runningNames.has(serviceName));
  } else {
    ensureNoOverlap(runningNames, orderedNames);
    selectedNames = orderedNames;
  }
  // Only now is it known which services this run starts; a pinned image for any other
  // service would be accepted and never used.
  validateImageOverrideTargets(images, selectedNames, runningNames);
  reportImageOverrides(modeConfig, images);

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
  const baseEnv = await loadBaseEnv(config, { allowMissing: options.prod });

  await writeState(config.projectDir, assignments);
  await writeRuntimeEnv(config.projectDir, generatedEnv);

  printPortTable(assignments, proxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames);
  warnMissingPortEnv(config, selectedNames);
  if (config.volumeSet && config.volumes.length > 0) {
    process.stdout.write(`[portler] volume set: ${config.volumeSet}\n`);
  }
  // Fires exactly when a set variant is about to be created empty (typo guard).
  await warnMissingVolumeSetVariants(config, selectedNames);

  const startedEntries = new Map<string, PidServiceInfo>();
  const children = new Map<string, ReturnType<typeof spawnService>>();
  // The live services of other runs the last teardown pass found, as their
  // entries read then: what it kept, it kept for them.
  let foreignRoots: Array<{ name: string; info: PidServiceInfo }> = [];
  // stopServices prunes its services' pids.json entries itself. It reports what
  // it could NOT stop, and a teardown that did not finish is an error: a
  // foreground `up` that exits 0 while a service it started is still running (and
  // still holding its port) tells a script the opposite of the truth — `down`
  // exits non-zero in exactly this situation. Release only safe reservations
  // before reporting an incomplete stop, so it still gives back what it can.
  const teardown = async ({ keepAdopted = true }: ForegroundTeardownOptions = {}): Promise<string[]> => {
    // The lifecycle lock is held here, but restart may have replaced an entry
    // while this foreground run was waiting. Names alone do not prove ownership.
    const current = await readPids(config.projectDir);
    const stopNames: string[] = [];
    const replaced = new Set<string>();
    // Every service this run selected is examined, port or not: a stale entry
    // for a portless service that never started is as much this run's to prune
    // as one for a service with a reservation. Release stays on reserveNames.
    // An entry is alive while its pid runs or, for a Docker service, while the
    // container it names still runs under this project's label: `docker run`
    // is supervised by a shell whose pid can be gone while the container runs
    // on, and stopServices removes a selected service's container by label
    // whatever its pid is doing. Each entry is inspected at most once.
    const liveness = new Map<string, Promise<EntryLiveness>>();
    const livenessOf = (serviceName: string, info: PidServiceInfo): Promise<EntryLiveness> => {
      let pending = liveness.get(serviceName);
      if (!pending) {
        pending = entryLiveness(config.projectDir, info);
        liveness.set(serviceName, pending);
      }
      return pending;
    };
    for (const serviceName of new Set([...selectedNames, ...reserveNames, ...startedEntries.keys()])) {
      const info = current?.services[serviceName];
      if (!info) continue;
      const started = startedEntries.get(serviceName);
      if (started && info.pid === started.pid && info.startToken === started.startToken) {
        stopNames.push(serviceName);
        continue;
      }
      const alive = await livenessOf(serviceName, info);
      if (alive.status === 'dead') {
        // A dead entry is nobody's, whoever wrote it: this run selected the
        // service but never spawned it (startup failed first) and the entry is
        // a stale one from an earlier run, or a restart replaced this run's
        // service and its replacement has already exited (no readiness check,
        // crashed at once; for a Docker service, container and all). stopServices
        // prunes it, and the reservation, if the service has a port, is released
        // below instead of lingering until the next prune. A live entry with
        // another identity, or one whose container cannot be inspected, is left
        // alone here.
        stopNames.push(serviceName);
      } else {
        replaced.add(serviceName);
        process.stderr.write(`[portler] leaving service "${serviceName}" alone: ${alive.reason}.\n`);
      }
    }
    // What a later run adopted stays up. `restart api` replaces api and keeps
    // this run's db and proxy as the replacement's dependencies, so their
    // entries still match this run; stopping them here would leave another
    // run's service without what it depends on. The dependencies walked are
    // the ones each entry recorded when it started, not this run's captured
    // config: portler.yml may have changed in between, and the restart read
    // the newer file. Anything a live foreign service depends on, and the
    // proxy while any such service remains, is left alone, reservation included.
    const foreignLive: string[] = [];
    for (const [serviceName, info] of Object.entries(current?.services ?? {})) {
      if (serviceName === PROXY_SERVICE_NAME || stopNames.includes(serviceName)) continue;
      if ((await livenessOf(serviceName, info)).status !== 'dead') foreignLive.push(serviceName);
    }
    foreignRoots = foreignLive.map((serviceName) => ({ name: serviceName, info: current!.services[serviceName]! }));
    let toStop = stopNames;
    let kept: string[] = [];
    if (keepAdopted && foreignLive.length > 0) {
      const adopted = await recordedDependencyClosure(config, current!, foreignLive);
      if (startedEntries.has(PROXY_SERVICE_NAME)) adopted.add(PROXY_SERVICE_NAME);
      // Only a live entry is kept. One of this run's that died before the
      // teardown (db crashed while the replacement still depends on it) is
      // nothing to keep: stopServices prunes it and its port is released.
      for (const serviceName of stopNames) {
        if (!adopted.has(serviceName)) continue;
        if ((await livenessOf(serviceName, current!.services[serviceName]!)).status !== 'dead') kept.push(serviceName);
      }
      toStop = stopNames.filter((serviceName) => !kept.includes(serviceName));
      for (const serviceName of kept) {
        replaced.add(serviceName);
        process.stderr.write(`[portler] leaving service "${serviceName}" alone: a service another run started depends on it.\n`);
      }
    }
    const result = await stopServices(config.projectDir, toStop);
    const incomplete = reportIncompleteTeardown(result);
    // Release follows what was stopped or pruned, not only what this run
    // reserved: a restart can give a service this run started portless a port
    // (portler.yml edited in between), and if that replacement is dead its
    // entry goes through stopServices above while its reservation would
    // otherwise block the port until the next prune.
    const remaining = new Set([...result.remaining, ...replaced]);
    await releasePorts(
      config.projectDir,
      [...new Set([...reserveNames, ...toStop])].filter((serviceName) => !remaining.has(serviceName)),
    );
    if (incomplete) throw new IncompleteTeardownError(result);
    return kept;
  };

  // False as soon as any root is gone, not only once all are: with api keeping
  // db and worker keeping cache, api's exit alone must free db. A root whose
  // entry was replaced since counts as gone too, checked before liveness: a
  // Docker root restarted again reuses its container name, so the snapshot's
  // container check would see the newer container and call the old root
  // alive. The pass this triggers reads pids.json again and keeps whatever the
  // survivors and newer services need.
  const dependentsAlive = async (): Promise<boolean> => {
    if (foreignRoots.length === 0) return true;
    const now = await readPids(config.projectDir);
    for (const { name, info } of foreignRoots) {
      const entry = now?.services[name];
      if (!entry || entry.pid !== info.pid || entry.startToken !== info.startToken) return false;
      if ((await entryLiveness(config.projectDir, info)).status === 'dead') return false;
    }
    return true;
  };

  try {
    // prod.require: a deployment that forgot a value fails here, before setup runs or
    // anything is spawned, naming the key instead of failing somewhere inside the app.
    if (options.prod) assertProductionRequirements(config, selectedNames, baseEnv);

    // Resolve every selected service's env (and healthcheck references) up
    // front, so config mistakes like `backend.urll` fail before anything is
    // spawned instead of after some services have already started.
    const serviceEnvs = new Map<string, ServiceEnv>();
    for (const serviceName of selectedNames) {
      const service = config.services[serviceName]!;
      serviceEnvs.set(serviceName, buildServiceEnv(config, service, baseEnv, generatedEnv, assignments));
      validateHealthcheckReferences(service, assignments);
    }

    const projectEnv = buildProjectEnv(config, baseEnv, assignments);

    const setupMode = `${mode}:${options.prod ? 'prod' : 'dev'}`;
    // Receipts are reconciled even with --no-setup: a step removed while setup was skipped
    // must not keep a receipt that a later normal up would trust.
    await pruneSetupReceipts(config, setupMode);
    if (options.setup !== false) {
      await runSetupStep(config, null, projectEnv, setupMode, options.setup);
    }

    // Start level by level: services within a level are independent, so they
    // spawn together and their readiness checks run concurrently; the next
    // level only starts once the whole level is up.
    // A member can die while something else is still starting: a service from
    // an earlier level while a later level comes up, or any service while the
    // proxy starts. Its own readiness wait returned long ago, so nothing else
    // would notice and `up` would report a started stack with a dead member.
    // The proxy's own exit is reported by its readiness wait.
    // Dependencies this run leaves running (restart's skipRunning) are not in
    // `children`, so their recorded pids are rechecked instead. For a Docker
    // service that pid is the `docker run` client, which exits with the container.
    // A zombie counts as dead: under a PID 1 that does not reap orphans, an
    // exited leader keeps its pid, and kill(pid, 0) alone would call it alive.
    const retained = orderedNames.filter((name) => runningNames.has(name) && !selectedNames.includes(name));
    const assertMembersAlive = (): void => {
      const spawnedDied = [...children]
        .filter(([name, child]) => name !== PROXY_SERVICE_NAME && (child.exitCode !== null || child.signalCode !== null))
        .map(([name]) => name);
      const retainedDied = retained.filter((name) => {
        const pid = pidsBefore?.services[name]?.pid;
        return pid !== undefined && !isPidAlive(pid);
      });
      const died = [...spawnedDied, ...retainedDied];
      if (died.length === 0) return;
      // A retained service was started by an earlier run; its log file is the
      // best pointer we have, whether or not that run was detached.
      const hints = died.map((name) =>
        logLocationHint(name, options.detach || retainedDied.includes(name) ? serviceLogPath(config.projectDir, name) : undefined),
      );
      throw new Error(
        `service${died.length > 1 ? 's' : ''} ${died.join(', ')} exited while the stack was still starting. ` +
          `${hints.length === 1 ? hints[0] : hints.join('; ')}, then run the same command again.`,
      );
    };
    for (const level of dependencyLevels(config, selectedNames)) {
      const readinessWaits: Array<() => Promise<void>> = [];

      for (const serviceName of level) {
        const service = config.services[serviceName]!;
        const { env: serviceEnv, explicitKeys } = serviceEnvs.get(serviceName)!;
        if (options.setup !== false) {
          await runSetupStep(config, service, serviceEnv, setupMode, options.setup);
        }
        let childExited = false;
        const logFilePath = options.detach ? serviceLogPath(config.projectDir, serviceName) : undefined;
        const child = spawnService(config, service, serviceEnv, explicitKeys, assignments[serviceName], assignments, !options.detach, logFilePath);
        child.once('exit', () => {
          childExited = true;
        });
        children.set(serviceName, child);
        if (options.detach) child.unref();

        const info = await pidInfoFor(config, service, child, assignments[serviceName]);
        startedEntries.set(serviceName, info);
        await recordPidEntry(config, serviceName, info);
        if (readinessNames.has(serviceName)) {
          readinessWaits.push(() =>
            waitForServiceReady(
              config,
              service,
              serviceEnv,
              assignments,
              assignments[serviceName],
              () => childExited,
              service.docker ? DOCKER_TCP_HOLD_MS : 0,
              logFilePath,
            ),
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
      // Catch a member of an earlier level that died while this one was
      // starting, before the next level, or the proxy, builds on it.
      assertMembersAlive();
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

      const info = await proxyPidInfoFor(config, child, assignments[PROXY_SERVICE_NAME]!);
      startedEntries.set(PROXY_SERVICE_NAME, info);
      await recordPidEntry(config, PROXY_SERVICE_NAME, info);
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
      // The proxy's wait took time too; a service that died meanwhile would
      // otherwise sit behind a printed project URL.
      assertMembersAlive();
    }
  } catch (error) {
    process.stderr.write('[portler] startup failed — stopping already-started services and releasing allocated ports\n');
    // The rollback must not replace the startup error with a cleanup error: the
    // reason the start failed is what the user needs to see. Whatever the
    // teardown could not do it has already reported for itself.
    // A rollback restores what was there before this run, so it keeps nothing
    // for another run: a service it started was not running before it, even if
    // a live service elsewhere depends on it. Keeping it would also leave this
    // failed `up` attached to a child nobody supervises.
    try {
      await teardown({ keepAdopted: false });
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

  return { children, teardown, dependentsAlive, detached: options.detach };
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

  return waitForForegroundServices(
    stack.children,
    (teardownOptions) => withLifecycleLockForTeardown(rawConfig.projectDir, () => stack.teardown(teardownOptions)),
    { dependentsAlive: stack.dependentsAlive },
  );
}

export async function commandUp(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  if (mode === 'k8s') {
    if (args.prod || args.setup !== undefined) throw new Error('--prod, --setup and --no-setup do not apply to k8s mode; build images separately');
    if (args.volumeSet !== undefined) throw new Error('--volume-set applies to Docker volumes, not "portler up k8s"');
    return commandUpK8s(args, requested);
  }

  const rawConfig = productionServices(await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet }), args.prod, requested);
  const requestedRootNames = selectServiceNames(rawConfig, requested);
  return startServices(rawConfig, mode, requestedRootNames, { detach: args.detach, prod: args.prod, setup: args.setup, images: args.images });
}
