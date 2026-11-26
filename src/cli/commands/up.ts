import { applyImageOverrides, assertServiceCwd, configForRunMode, loadBaseEnv, loadConfig, proxyServiceConfig, type RunMode } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { buildProjectEnv, forgetVolumeSetupReceipts, pruneSetupReceipts, runSetupStep, setupModeKey } from '../../setup/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertEnvRequirements, buildGeneratedEnv, buildServiceEnv, hostResolveOptions, resolveEnvValue, type ResolveOptions } from '../../env/index.ts';
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
import { missingManagedVolumes, warnMissingVolumeSetVariants } from '../../volumes/index.ts';
import { applyShare, chooseShare } from '../../share/settings.ts';
import { reportShare } from '../../share/report.ts';
import { readinessProvesListening, waitForSharedPort } from '../../share/ready.ts';
import { shareForwardSpec } from '../../share/command.ts';
import type { Assignments, EnvMap, PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig, ShareSettings } from '../../types/index.ts';
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

// A typo like `backend.urll` fails before any service starts, not mid-poll.
function validateHealthcheckReferences(service: ServiceConfig, assignments: Assignments, options: ResolveOptions): void {
  const healthcheck = service.healthcheck;
  if (!healthcheck) return;

  try {
    if (healthcheck.url) resolveEnvValue(healthcheck.url, assignments, options);
    if (healthcheck.command) resolveEnvValue(healthcheck.command, assignments, options);
  } catch (error) {
    throw new Error(`services.${service.name}.healthcheck: ${(error as Error).message}`);
  }
}

// Written after every spawn, so a crash mid-startup leaves a pids.json `down` can clean up. The merge
// runs under the project lock, so entries another invocation writes survive.
async function recordPidEntry(config: PortlerConfig, serviceName: string, info: PidServiceInfo): Promise<void> {
  await updatePids(config.projectDir, (pids) => {
    pids.services[serviceName] = info;
  });
}

/** Says what a teardown could not stop, since silence reads as "everything is down". Returns whether
 * it was incomplete, so the caller can exit non-zero as `down` does. */
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
  /** Foreground startup cancellation; rollback runs before the lifecycle lock is released. */
  signal?: AbortSignal;
  /** Skip already-running services instead of failing (used by restart). */
  skipRunning?: boolean;
  /** `--image <service>=<image>`: run these Docker services from pinned images instead of building them. */
  images?: Readonly<Record<string, string>>;
  /** `--share <target>` (or `none`); without it a running stack's share is kept. */
  share?: string;
  /** PORTLER_SHARE: used only when nothing runs yet. */
  shareDefault?: string;
  /** restart: the share its stopped services were started with. */
  replayShare?: ShareSettings;
  /** restart: the services its plan covers. If what is not running differs, startPhase throws
   * StartSetChangedError before starting anything. */
  expectStart?: readonly string[];
  /** up: the `restart` a refusal over running services suggests; undefined when that restart would not
   * do what was asked. */
  restartHint?: (serviceNames: string[], pidsBefore: PidsFile | null, runningNames: ReadonlySet<string>) => Promise<string | undefined>;
}

/** Carries this invocation's mode, file and launch options: a service with no PID entry has nothing
 * to replay, so a pinned image or another portler.yml would be lost. */
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
  /** Stops this run's services and releases its ports. UNLOCKED: startPhase's failure path already
   * holds the non-reentrant lock; the foreground caller takes it again. Returns the services kept
   * because another run's service depends on them; `keepAdopted: false` stops those too. */
  teardown: (options?: ForegroundTeardownOptions) => Promise<string[]>;
  /** Whether every other run's service the last teardown kept something for is alive. Nothing reports
   * their exit, so the attached supervisor asks; the first exit means another teardown pass. */
  dependentsAlive: () => Promise<boolean>;
  detached: boolean;
}

type EntryLiveness = { status: 'alive' | 'unknown'; reason: string } | { status: 'dead' };

// An uninspectable container is 'unknown' and treated as alive: stopServices would remove a
// container another run may be serving through.
async function entryLiveness(projectDir: string, info: PidServiceInfo): Promise<EntryLiveness> {
  const liveness = await serviceLiveness(projectDir, info);
  if (liveness.status === 'running' && liveness.via === 'pid') return { status: 'alive', reason: 'its PID entry belongs to another run' };
  if (liveness.status === 'running' && liveness.via === 'group') return { status: 'alive', reason: liveness.message };
  if (liveness.status === 'running') {
    return { status: 'alive', reason: `its container "${info.dockerContainer}" is still running under another run` };
  }
  if (liveness.status === 'unknown') {
    return { status: 'unknown', reason: `its container "${info.dockerContainer}" could not be inspected (${liveness.message})` };
  }
  return { status: 'dead' };
}

// As each entry recorded at start, whichever portler.yml its run read. An entry without a record
// uses the config on disk now; a file that no longer loads means none.
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

/** Applies prod.services, the run mode, pinned images and production overrides, in that order. `raw`
 * is narrowed to prod.services, `modeConfig` is its run-mode view before images are pinned. */
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

/** startPhase's checks before it allocates or spawns. restart runs them before it stops anything, so
 * a launch that could not start is refused while the services are still up. */
export function checkLaunch(config: PortlerConfig, mode: RunMode, selectedNames: string[]): void {
  if (mode === 'docker') validateDockerMode(config, selectedNames);
  validateCommands(config, selectedNames);
  validateServiceDirectories(config, selectedNames);
  validateDockerContainerNames(config);
}

/** Behind `up` and `restart`: allocates ports and spawns in dependency order. The caller holds the
 * lifecycle lock, so `restart` can keep one lock across its stop and start. */
export async function startPhase(
  rawConfig: PortlerConfig,
  mode: RunMode,
  requestedRootNames: string[],
  options: StartOptions,
): Promise<StartedStack> {
  options.signal?.throwIfAborted();
  // Under --prod only prod.services run; dependencies on left-out services are dropped.
  const { raw, modeConfig, config: launched } = launchConfig(rawConfig, mode, { prod: options.prod, images: options.images });
  const orderedNames = expandAndOrderServices(raw, requestedRootNames);
  const images = options.images ?? {};
  const pidsBefore = await readPids(rawConfig.projectDir);
  // Running as `ps` reports it: starting a Docker service whose container outlived its `docker run`
  // shell would remove that container. One that cannot be inspected counts as running too.
  const runningNames = new Set(
    await liveServiceNames(rawConfig.projectDir, pidsBefore, (serviceName, message) => {
      process.stderr.write(`[portler] warning: ${serviceName}: ${message}; treating it as running\n`);
    }),
  );

  // Before the overlap check, whose restart hint would keep the running share.
  const liveEntries = [...runningNames].flatMap((name) => pidsBefore?.services[name] ?? []);
  const request = options.share ?? (liveEntries.length === 0 ? options.shareDefault : undefined);
  const share = await chooseShare(liveEntries, request, options.replayShare);
  if (share && options.prod) {
    throw new Error(`this stack is running with --share ${share.target}, which does not apply with --prod; run "portler down" first`);
  }

  let selectedNames: string[];
  if (options.skipRunning) {
    selectedNames = orderedNames.filter((serviceName) => !runningNames.has(serviceName));
  } else {
    // `up worker` with redis running usually means "bring worker back": suggest restarting the requested
    // services not running (all, if every one runs), unless that restart would refuse or differ from this.
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

  const config = applyShare(launched, share);
  checkLaunch(config, mode, selectedNames);

  // A proxy that is already running keeps its port and old routing targets;
  // only start (and later stop) it when it is not up yet.
  const proxy = config.proxy;
  const startProxy = proxy !== undefined && !runningNames.has(PROXY_SERVICE_NAME);

  const state = await readState(config.projectDir);
  const reserveNames = servicesWithPorts(config, selectedNames);
  if (startProxy) reserveNames.push(PROXY_SERVICE_NAME);
  const readinessNames = servicesNeedingReadiness(config, selectedNames, requestedRootNames);
  // Ctrl-C may end the wait for another project's hold on the port registry: nothing
  // is reserved or started yet. Later waits are not cancellable on purpose: the pid
  // entry written after each spawn is how the rollback finds what to stop.
  const assignments = await allocateAssignments(config, state, reserveNames, runningNames, {
    signal: options.signal,
    recorded: pidsBefore?.services,
  });
  const generatedEnv = buildGeneratedEnv(assignments);
  const baseEnv = await loadBaseEnv(config, { allowMissing: options.prod });

  await writeState(config.projectDir, assignments);
  await writeRuntimeEnv(config.projectDir, generatedEnv);

  printPortTable(assignments, proxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames);
  reportShare(config, startProxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames, assignments);
  warnMissingPortEnv(config, selectedNames);
  if (config.volumeSet && config.volumes.length > 0) {
    process.stdout.write(`[portler] volume set: ${config.volumeSet}\n`);
  }
  // Fires exactly when a set variant is about to be created empty (typo guard).
  await warnMissingVolumeSetVariants(config, selectedNames);
  // Asked before anything spawns: starting a Docker service creates its volumes.
  const newVolumes = await missingManagedVolumes(config, selectedNames);

  const startedEntries = new Map<string, PidServiceInfo>();
  const children = new Map<string, ReturnType<typeof spawnService>>();
  // The live services of other runs the last teardown pass found, as their
  // entries read then: what it kept, it kept for them.
  let foreignRoots: Array<{ name: string; info: PidServiceInfo }> = [];
  // An incomplete teardown is an error, as in `down`: a foreground `up` exiting 0 while its service
  // still holds a port misleads scripts. Safe reservations are still released first.
  const teardown = async ({ keepAdopted = true }: ForegroundTeardownOptions = {}): Promise<string[]> => {
    // The lifecycle lock is held here, but restart may have replaced an entry
    // while this foreground run was waiting. Names alone do not prove ownership.
    const current = await readPids(config.projectDir);
    const stopNames: string[] = [];
    const replaced = new Set<string>();
    // Every selected service is examined, port or not: a stale portless entry is this run's to prune too.
    // A Docker entry is alive while its labelled container runs, even with the shell's pid gone, since
    // stopServices removes a selected service's container by label. Each entry is inspected once.
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
        // A dead entry is nobody's (a stale one this run never spawned, or a restart's exited replacement):
        // prune it. A live entry with another identity, or an uninspectable container, is left alone.
        stopNames.push(serviceName);
      } else {
        replaced.add(serviceName);
        process.stderr.write(`[portler] leaving service "${serviceName}" alone: ${alive.reason}.\n`);
      }
    }
    // What a later run adopted stays up: `restart api` keeps this run's db and proxy for the new api.
    // Walk the dependencies each entry recorded, not this config (the restart may have read a newer
    // portler.yml). What a live foreign service depends on, and the proxy while one remains, stays.
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
      // Only a live entry is kept: one of this run's that died (db crashed) is pruned and
      // its port released.
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
    // Also release what was stopped or pruned: a restart can give a portless service of this
    // run a port, and a dead replacement's reservation would block it until the next prune.
    const remaining = new Set([...result.remaining, ...replaced]);
    await releasePorts(
      config.projectDir,
      [...new Set([...reserveNames, ...toStop])].filter((serviceName) => !remaining.has(serviceName)),
    );
    if (incomplete) throw new IncompleteTeardownError(result);
    return kept;
  };

  // False once any root is gone, so api's exit frees db while worker still keeps cache. A replaced
  // entry counts as gone, checked first: a restarted Docker root reuses its container name.
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
    options.signal?.throwIfAborted();
    // prod.require and `required:` entries: a missing value fails here, before setup runs
    // or anything is spawned, naming every missing key instead of failing inside the app.
    assertEnvRequirements(config, selectedNames, baseEnv, { projectSetup: options.setup !== false });

    // Resolve every reference before anything spawns. A container service also gets its host-side env
    // for setup steps and healthcheck commands: `${db.address}` differs between the two.
    const serviceEnvs = new Map<string, ServiceEnv>();
    const hostEnvs = new Map<string, EnvMap>();
    for (const serviceName of selectedNames) {
      const service = config.services[serviceName]!;
      const built = buildServiceEnv(config, service, baseEnv, generatedEnv, assignments);
      serviceEnvs.set(serviceName, built);
      hostEnvs.set(serviceName, service.docker ? buildServiceEnv(config, service, baseEnv, generatedEnv, assignments, { viewer: 'host' }).env : built.env);
      validateHealthcheckReferences(service, assignments, hostResolveOptions(config, service, baseEnv, generatedEnv, assignments));
    }

    // Only build the project view for project steps: shared env may use `self.*`, which
    // means nothing for the project.
    const projectEnv = options.setup !== false && config.setup?.length
      ? buildProjectEnv(config, baseEnv, assignments, generatedEnv) : {};
    // A non-empty template can resolve to empty, so check the composed envs too.
    assertEnvRequirements(config, selectedNames, baseEnv, {
      projectSetup: options.setup !== false,
      projectEnv,
      envs: new Map([...serviceEnvs].map(([name, built]) => [name, built.env])),
    });

    const setupMode = setupModeKey(config, mode, options.prod);
    // Receipts are reconciled even with --no-setup: a step removed while setup was skipped
    // must not keep a receipt that a later normal up would trust.
    await pruneSetupReceipts(config, setupMode);
    // A managed volume about to be created is empty, so migration receipts no longer hold for it in
    // either run mode that mounts it. Also with --no-setup, which still creates the volume.
    if (newVolumes?.length) {
      if (await forgetVolumeSetupReceipts(config)) {
        process.stdout.write(`[portler] new volume ${newVolumes.join(', ')}: setup steps run again\n`);
      }
    }
    if (options.setup !== false) {
      await runSetupStep(config, null, projectEnv, setupMode, options.setup, options.signal);
    }

    // A member can die after its readiness wait, while a later level or the proxy starts: check after
    // each step. Retained dependencies go by serviceLiveness, not pid (a container can outlive its shell,
    // an unreaped zombie passes kill(pid, 0)); an uninspectable one is not reported dead.
    const retained = orderedNames.filter((name) => runningNames.has(name) && !selectedNames.includes(name));
    const assertMembersAlive = async (): Promise<void> => {
      const retainedInfo = retained.map((name) => pidsBefore?.services[name]);
      const probe = (index: number): Promise<ServiceLiveness | undefined> => {
        const info = retainedInfo[index];
        return info === undefined ? Promise.resolve(undefined) : serviceLiveness(config.projectDir, info);
      };
      const retainedLiveness = await Promise.all(retained.map((_, index) => probe(index)));
      // A pid-only verdict goes stale if that process exits during another inspect: recheck those pids
      // before reading the children, probing a gone one again (its container may run on) until none is.
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
      // A retained service's log file is the best pointer, whether or not its run was detached.
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
        options.signal?.throwIfAborted();
        const service = config.services[serviceName]!;
        const { env: serviceEnv, explicitKeys } = serviceEnvs.get(serviceName)!;
        const hostEnv = hostEnvs.get(serviceName)!;
        if (options.setup !== false) {
          await runSetupStep(config, service, hostEnv, setupMode, options.setup, options.signal);
        }
        options.signal?.throwIfAborted();
        let childExited = false;
        const logFilePath = options.detach ? serviceLogPath(config.projectDir, serviceName) : undefined;
        const child = spawnService(config, service, serviceEnv, explicitKeys, assignments[serviceName], assignments, !options.detach, logFilePath, baseEnv);
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
              hostEnv,
              assignments,
              assignments[serviceName],
              () => childExited,
              service.docker ? DOCKER_TCP_HOLD_MS : 0,
              logFilePath,
              options.signal,
              hostResolveOptions(config, service, baseEnv, generatedEnv, assignments),
            ).then(async () => {
              const assignment = assignments[serviceName];
              if (config.share && assignment && shareForwardSpec(config, service, assignment) && readinessProvesListening(service, assignment)) {
                await waitForSharedPort(config.share, assignment, () => childExited, options.signal);
              }
            }),
          );
        }
      }

      const waits = readinessWaits.map((wait) => wait());
      // Siblings failing after the first must not be unhandled rejections; Promise.all still
      // fails on the first without waiting for slower siblings.
      for (const wait of waits) wait.catch(() => {});
      await Promise.all(waits);
      await assertMembersAlive();
      options.signal?.throwIfAborted();
    }

    // The proxy starts last so every routed service already listens; it
    // tolerates down targets anyway by answering 502.
    options.signal?.throwIfAborted();
    if (proxy && startProxy) {
      let proxyExited = false;
      const child = spawnProxy(proxy, assignments, !options.detach, config.share);
      child.once('exit', () => {
        proxyExited = true;
      });
      children.set(PROXY_SERVICE_NAME, child);
      if (options.detach) child.unref();

      const info = await proxyPidInfoFor(config, child, assignments[PROXY_SERVICE_NAME]!);
      startedEntries.set(PROXY_SERVICE_NAME, info);
      await recordPidEntry(config, PROXY_SERVICE_NAME, info);
      // The synthetic config gives the default TCP wait, so the project URL prints only once
      // the proxy accepts connections.
      await waitForServiceReady(
        config,
        proxyServiceConfig(config, proxy),
        {},
        assignments,
        assignments[PROXY_SERVICE_NAME],
        () => proxyExited,
        0,
        undefined,
        options.signal,
      );
      if (config.share) {
        await waitForSharedPort(config.share, assignments[PROXY_SERVICE_NAME]!, () => proxyExited, options.signal);
        if (proxyExited) throw new Error('the proxy exited while it was opening its shared listeners; run it in the foreground (portler up --share ...) to see why');
      }
      await assertMembersAlive();
      options.signal?.throwIfAborted();
    }
  } catch (error) {
    process.stderr.write(
      startedEntries.size > 0 || children.size > 0
        ? '[portler] startup failed — stopping already-started services and releasing allocated ports\n'
        : '[portler] startup failed before any service started — releasing allocated ports\n',
    );
    // The rollback reports its own problems and must not replace the startup error. It keeps nothing
    // for another run: this run's services were not running before, and a kept child is unsupervised.
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

/** Foreground startup cancellation, as `up` and `up k8s` install it. */
export interface StartupCancellation {
  /** Aborted (with the signal's name as reason) on the first SIGINT/SIGTERM; none for detached startup. */
  signal: AbortSignal | undefined;
  /** 130 or 143 once a signal arrived. */
  exitCode: () => number | undefined;
  /** Remove the handlers; call it right before the foreground supervisor installs its own. */
  unlisten: () => void;
}

/** Detached startup installs no handlers; foreground ones exist before startup can spawn anything. */
export function listenForStartupCancellation(detach: boolean): StartupCancellation {
  if (detach) return { signal: undefined, exitCode: () => undefined, unlisten: () => {} };
  const cancellation = new AbortController();
  let signalCode: number | undefined;
  const cancel = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (signalCode !== undefined) return;
    signalCode = signal === 'SIGINT' ? 130 : 143;
    process.stderr.write(`[portler] received ${signal}, stopping services...\n`);
    // Like the running supervisor: a second Ctrl-C during the rollback gets the
    // default handling, so a stuck rollback can still be interrupted.
    unlisten();
    // Carry the original signal through to an active setup shell, or to the
    // docker/kubectl command a Kubernetes start is waiting on.
    cancellation.abort(signal);
  };
  const interrupt = (): void => cancel('SIGINT');
  const terminate = (): void => cancel('SIGTERM');
  const unlisten = (): void => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  return { signal: cancellation.signal, exitCode: () => signalCode, unlisten };
}

/** startPhase under the lifecycle lock. The foreground wait runs outside it, or it would block every
 * command until Ctrl-C, including the `down` meant to stop it. The teardown that ends the wait retakes
 * the lock; startPhase's failure path already holds it and uses the raw teardown, so nothing nests. */
export async function startServices(
  rawConfig: PortlerConfig,
  mode: RunMode,
  requestedRootNames: string[],
  options: StartOptions,
): Promise<number> {
  const cancellation = listenForStartupCancellation(options.detach);
  const { signal } = cancellation;
  try {
    // The signal also ends a wait for a lock another command holds.
    const stack = await withLifecycleLock(rawConfig.projectDir, async () => {
      const stack = await startPhase(rawConfig, mode, requestedRootNames, {
        ...options,
        ...(signal ? { signal } : {}),
      });
      // A signal that arrived after the last startup check still rolls back under this lock.
      if (signal?.aborted) {
        await stack.teardown({ keepAdopted: false });
        signal.throwIfAborted();
      }
      return stack;
    }, { signal });

    if (stack.detached) return 0;
    if (signal?.aborted) {
      // A signal during the lock's release still belongs to startup; tear down under the lock.
      await withLifecycleLockForTeardown(rawConfig.projectDir, () => stack.teardown({ keepAdopted: false }));
      return cancellation.exitCode()!;
    }

    // No await between removing our handlers and the supervisor installing its own.
    cancellation.unlisten();
    return waitForForegroundServices(
      stack.children,
      (teardownOptions) => withLifecycleLockForTeardown(rawConfig.projectDir, () => stack.teardown(teardownOptions)),
      { dependentsAlive: stack.dependentsAlive },
    );
  } catch (error) {
    const exitCode = cancellation.exitCode();
    if (exitCode !== undefined) return exitCode;
    throw error;
  } finally {
    cancellation.unlisten();
  }
}

/** `--share`, refused with --prod, whose ports belong behind the deployment's own edge. */
export function shareRequest(args: Pick<ParsedArgs, 'share' | 'prod'>): string | undefined {
  if (args.prod && args.share !== undefined && args.share !== 'none') {
    throw new Error('--share does not apply with --prod; put a production stack behind its own edge (see "Behind a TLS edge" in the proxy guide)');
  }
  return args.share;
}

/** PORTLER_SHARE: only a default for a stack that is not running yet, and never under --prod. */
export function shareDefault(args: Pick<ParsedArgs, 'prod'>): string | undefined {
  return args.prod ? undefined : process.env.PORTLER_SHARE?.trim() || undefined;
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
    share: shareRequest(args),
    shareDefault: shareDefault(args),
    // Offered only if the suggested restart would pass its checks and replay nothing this
    // command did not say (a pin on a service it leaves running, a stale entry's --prod or mode).
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
