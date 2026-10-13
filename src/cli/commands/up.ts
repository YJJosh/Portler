import { applyImageOverrides, assertServiceCwd, configForRunMode, loadBaseEnv, loadConfig, proxyServiceConfig, type RunMode } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { buildProjectEnv, pruneSetupReceipts, runSetupStep } from '../../setup/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertProductionRequirements, buildGeneratedEnv, buildServiceEnv, resolveEnvValue } from '../../env/index.ts';
import type { ServiceEnv } from '../../env/index.ts';
import { allocateAssignments, releasePorts } from '../../ports/index.ts';
import { shellQuote } from '../../process/docker.ts';
import {
  isPidAlive,
  liveServiceNames,
  pidInfoFor,
  readPids,
  serviceLogPath,
  serviceLiveness,
  spawnService,
  stopServices,
  updatePids,
  waitForForegroundServices,
} from '../../process/index.ts';
import type { ForegroundTeardownOptions, ServiceLiveness, StopResult } from '../../process/index.ts';
import { proxyPidInfoFor, spawnProxy } from '../../proxy/index.ts';
import { DOCKER_TCP_HOLD_MS, logLocationHint, waitForServiceReady } from '../../readiness/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../../state/lock.ts';
import { warnMissingVolumeSetVariants } from '../../volumes/index.ts';
import type { Assignments, PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { restartAccepts, type RestartRequest } from './restart.ts';
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

function validateServiceDirectories(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) assertServiceCwd(config, config.services[serviceName]!);
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

/** startPhase found other services to start than its caller planned for; nothing was started. */
export class StartSetChangedError extends Error {
  constructor(planned: readonly string[], found: readonly string[]) {
    const names = (list: readonly string[]): string => (list.length > 0 ? list.join(', ') : 'none');
    super(`the services to start changed after they were planned (planned ${names(planned)}, found ${names(found)})`);
    this.name = 'StartSetChangedError';
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
  /**
   * restart: the services its plan covers. When what is not running differs by the time
   * startPhase reads pids.json (a dependency exited after the plan was made), it throws
   * StartSetChangedError before anything is started, so the caller can plan again.
   */
  expectStart?: readonly string[];
  /**
   * up: the `restart` a refusal over already-running services suggests for the services it
   * should start, carrying this invocation's options; none when that restart would not do
   * what was asked. It is judged on the pids.json and running set the refusal comes from.
   */
  restartHint?: (serviceNames: string[], pidsBefore: PidsFile | null, runningNames: ReadonlySet<string>) => Promise<string | undefined>;
}

/**
 * The `restart` that does what a refused `up` asked for: it starts the named services and
 * keeps what is running. It carries this invocation's mode, config file and launch options,
 * because a service with no PID entry has nothing for restart to replay: without them a
 * pinned image or another portler.yml would quietly be lost.
 */
export function restartSuggestion(
  args: Pick<ParsedArgs, 'file' | 'prod' | 'setup' | 'images' | 'volumeSet'>,
  mode: RunMode,
  serviceNames: readonly string[],
): string {
  const parts = ['portler', 'restart'];
  if (mode === 'docker') parts.push('docker');
  parts.push(...serviceNames.map(shellQuote));
  if (args.file) parts.push('--file', shellQuote(args.file));
  if (args.prod) parts.push('--prod');
  if (args.setup === true) parts.push('--setup');
  if (args.setup === false) parts.push('--no-setup');
  for (const [service, image] of Object.entries(args.images ?? {})) parts.push('--image', shellQuote(`${service}=${image}`));
  if (args.volumeSet !== undefined) parts.push('--volume-set', shellQuote(args.volumeSet));
  return parts.join(' ');
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
 * Whether a pids.json entry still names something alive, in the words the
 * teardown reports (serviceLiveness decides). An entry whose container cannot
 * be inspected is 'unknown' and treated as alive: handing it to stopServices
 * would remove a container another run may be serving through, and guessing
 * "dead" is the one mistake that destroys something.
 */
async function entryLiveness(projectDir: string, info: PidServiceInfo): Promise<EntryLiveness> {
  const liveness = await serviceLiveness(projectDir, info);
  if (liveness.status === 'running' && liveness.via === 'pid') return { status: 'alive', reason: 'its PID entry belongs to another run' };
  if (liveness.status === 'running') {
    return { status: 'alive', reason: `its container "${info.dockerContainer}" is still running under another run` };
  }
  if (liveness.status === 'unknown') {
    return { status: 'unknown', reason: `its container "${info.dockerContainer}" could not be inspected (${liveness.message})` };
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
/**
 * The configuration a start in `mode` runs with: prod.services, the run mode, pinned
 * images and the production overrides applied, in that order. `raw` is the stack narrowed
 * to prod.services and `modeConfig` the run mode's view of it, before images are pinned.
 */
export function launchConfig(
  rawConfig: PortlerConfig,
  mode: RunMode,
  options: { prod?: boolean; images?: Readonly<Record<string, string>> },
): { raw: PortlerConfig; modeConfig: PortlerConfig; config: PortlerConfig } {
  const raw = productionServices(rawConfig, options.prod);
  const modeConfig = configForRunMode(raw, mode);
  const config = applyProduction(applyImageOverrides(modeConfig, options.images ?? {}), options.prod);
  return { raw, modeConfig, config };
}

/**
 * What startPhase checks about the services it is about to start, before it allocates a
 * port or spawns anything. restart makes the same checks before it stops anything, so a
 * launch that could not start is refused while the services are still up.
 */
export function checkLaunch(config: PortlerConfig, mode: RunMode, selectedNames: string[]): void {
  if (mode === 'docker') validateDockerMode(config, selectedNames);
  validateCommands(config, selectedNames);
  validateServiceDirectories(config, selectedNames);
  validateDockerContainerNames(config);
}

export async function startPhase(
  rawConfig: PortlerConfig,
  mode: RunMode,
  requestedRootNames: string[],
  options: StartOptions,
): Promise<StartedStack> {
  // Under --prod only prod.services run; dependencies on left-out services are dropped.
  const { raw, modeConfig, config } = launchConfig(rawConfig, mode, { prod: options.prod, images: options.images });
  const orderedNames = expandAndOrderServices(raw, requestedRootNames);
  const images = options.images ?? {};
  const pidsBefore = await readPids(config.projectDir);
  // Running by serviceLiveness, as `ps` reports it: a Docker service whose `docker run`
  // shell is gone but whose container runs on is running, and starting it would remove
  // that container. One that cannot be inspected is taken as running too.
  const runningNames = new Set(
    await liveServiceNames(config.projectDir, pidsBefore, (serviceName, message) => {
      process.stderr.write(`[portler] warning: could not inspect ${serviceName}'s container (${message}); treating it as running\n`);
    }),
  );

  let selectedNames: string[];
  if (options.skipRunning) {
    selectedNames = orderedNames.filter((serviceName) => !runningNames.has(serviceName));
  } else {
    // `up worker` with redis running usually means "bring worker back": restart does that and
    // keeps the running dependencies, so it is the first thing the refusal suggests. It names
    // only the requested services that are not running (naming a running one would restart
    // it), unless every one of them runs, and it runs them in the background.
    // When that restart would refuse, or would start them otherwise than asked (in the mode or
    // with the --prod what runs was started with), only the down that clears the way is offered.
    const notRunning = requestedRootNames.filter((serviceName) => !runningNames.has(serviceName));
    const restartNames = notRunning.length > 0 ? notRunning : requestedRootNames;
    const overlap = orderedNames.some((serviceName) => runningNames.has(serviceName));
    const restart = overlap && options.restartHint ? await options.restartHint(restartNames, pidsBefore, runningNames) : undefined;
    ensureNoOverlap(runningNames, orderedNames, restart, restart && !options.detach ? 'restart starts them in the background' : undefined);
    selectedNames = orderedNames;
  }
  if (options.expectStart !== undefined) {
    const planned = new Set(options.expectStart);
    if (selectedNames.length !== planned.size || selectedNames.some((name) => !planned.has(name))) {
      throw new StartSetChangedError(options.expectStart, selectedNames);
    }
  }
  // Only now is it known which services this run starts; a pinned image for any other
  // service would be accepted and never used.
  validateImageOverrideTargets(images, selectedNames, runningNames);
  reportImageOverrides(modeConfig, images);

  checkLaunch(config, mode, selectedNames);

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
    if (options.prod) assertProductionRequirements(config, selectedNames, baseEnv, { projectSetup: options.setup !== false });

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
    // `children`, so their recorded entries are rechecked instead, by the same
    // measure that counted them as running: serviceLiveness. Their pid alone is not
    // enough: a Docker service's container can outlive the `docker run` shell whose
    // pid was recorded, and a zombie (under a PID 1 that does not reap orphans)
    // keeps a pid that kill(pid, 0) would call alive. One whose container cannot be
    // inspected is not reported as dead: this run could not confirm it either way.
    const retained = orderedNames.filter((name) => runningNames.has(name) && !selectedNames.includes(name));
    const assertMembersAlive = async (): Promise<void> => {
      const retainedInfo = retained.map((name) => pidsBefore?.services[name]);
      const probe = (index: number): Promise<ServiceLiveness | undefined> => {
        const info = retainedInfo[index];
        return info === undefined ? Promise.resolve(undefined) : serviceLiveness(config.projectDir, info);
      };
      const retainedLiveness = await Promise.all(retained.map((_, index) => probe(index)));
      // A verdict reached by the pid alone goes stale if that process exits while another
      // service's container is still being inspected. Check those pids again, with no wait
      // between this check and the reading of the children below; one whose pid is gone is
      // asked about again (its container may run on), which can take another inspect, so
      // repeat until a pass finds nothing stale. Each service is asked again at most once.
      const reprobed = new Set<number>();
      for (;;) {
        const stale = retained
          .map((_, index) => index)
          .filter((index) => {
            const result = retainedLiveness[index];
            return result?.status === 'running' && result.via === 'pid' && !isPidAlive(retainedInfo[index]!.pid);
          });
        if (stale.length === 0) break;
        const again = stale.filter((index) => !reprobed.has(index));
        for (const index of stale) {
          if (reprobed.has(index)) retainedLiveness[index] = { status: 'dead' };
        }
        if (again.length === 0) continue;
        again.forEach((index) => reprobed.add(index));
        const answers = await Promise.all(again.map((index) => probe(index)));
        again.forEach((index, k) => {
          retainedLiveness[index] = answers[k];
        });
      }
      const retainedDied = retained.filter((_, index) => retainedLiveness[index]?.status === 'dead');
      // Read the children after the probes above: a docker inspect can take a while,
      // and a child that exited during it must not slip past the last check of the run.
      const spawnedDied = [...children]
        .filter(([name, child]) => name !== PROXY_SERVICE_NAME && (child.exitCode !== null || child.signalCode !== null))
        .map(([name]) => name);
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

        const info = await pidInfoFor(config, service, child, assignments[serviceName], {
          runMode: mode,
          ...(options.images?.[serviceName] !== undefined ? { image: options.images[serviceName] } : {}),
          ...(options.setup === false ? { setup: false } : {}),
        });
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
      await assertMembersAlive();
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
      await assertMembersAlive();
    }
  } catch (error) {
    process.stderr.write(
      startedEntries.size > 0 || children.size > 0
        ? '[portler] startup failed — stopping already-started services and releasing allocated ports\n'
        : '[portler] startup failed before any service started — releasing allocated ports\n',
    );
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

  const loadedConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });
  const rawConfig = productionServices(loadedConfig, args.prod, requested);
  const requestedRootNames = selectServiceNames(rawConfig, requested);
  return startServices(rawConfig, mode, requestedRootNames, {
    detach: args.detach,
    prod: args.prod,
    setup: args.setup,
    images: args.images,
    // Offered only if restart, run as suggested, would plan and pass its checks without
    // replaying anything this command did not say: a pin on a service it leaves running, a
    // stale entry recorded with another --prod or mode, would make it refuse or differ.
    restartHint: async (serviceNames, pidsBefore, runningNames) => {
      const request: RestartRequest = {
        mode,
        requested: serviceNames,
        modeExplicit: mode === 'docker',
        prod: args.prod,
        setup: args.setup,
        images: args.images,
      };
      const accepted = await restartAccepts(loadedConfig, request, pidsBefore, runningNames);
      return accepted ? restartSuggestion(args, mode, serviceNames) : undefined;
    },
  });
}
