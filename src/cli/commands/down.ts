import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { deleteK8sResources, deployedK8sServices, detectCluster, type K8sDeleteResult } from '../../k8s/index.ts';
import { releasePorts } from '../../ports/index.ts';
import type { RunMode } from '../../config/index.ts';
import { shellQuote } from '../../process/docker.ts';
import { liveServiceNames, readPids, stopServices } from '../../process/index.ts';
import type { StopResult } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, servicesWithPorts } from '../services.ts';
import { legacyMountCandidates, restartAccepts, type RestartRequest } from './restart.ts';

/**
 * Like selectServiceNames, but also accepts "proxy" as a target when a proxy
 * block exists (the proxy is not a service, yet `portler down proxy` should
 * stop it).
 */
export function selectDownTargets(config: PortlerConfig, requested: string[]): string[] {
  const names: string[] = [];

  for (const name of requested) {
    if (name === PROXY_SERVICE_NAME && config.proxy) {
      names.push(name);
      continue;
    }
    if (!config.services[name]) throw new Error(`unknown service "${name}"`);
    names.push(name);
  }

  return names;
}

/** The selected targets that hold a port reservation worth releasing. */
function releaseTargets(config: PortlerConfig, selectedNames: string[]): string[] {
  const serviceNames = servicesWithPorts(
    config,
    selectedNames.filter((name) => name !== PROXY_SERVICE_NAME),
  );
  if (config.proxy && selectedNames.includes(PROXY_SERVICE_NAME)) serviceNames.push(PROXY_SERVICE_NAME);
  return serviceNames;
}

/**
 * Reservations are released only for teardown targets that are not still
 * recorded as incomplete. Include completed stale PID entries even when the
 * service was removed from the current config, so a normal full `down` still
 * cleans old registry entries without giving back a live service's port.
 */
function releasableTargets(config: PortlerConfig, selectedNames: string[] | undefined, result: StopResult): string[] {
  const configured = releaseTargets(
    config,
    selectedNames ?? [...Object.keys(config.services), ...(config.proxy ? [PROXY_SERVICE_NAME] : [])],
  );
  const remaining = new Set(result.remaining);
  return [...new Set([...configured, ...result.completed])].filter((name) => !remaining.has(name));
}

/**
 * The volume set a stopped service's `@` volumes were on, as far as its entry says: the
 * set (`''` for the base volumes) when it recorded one, undefined when it mounts no `@`
 * volume in the mode it ran in, and null when it does but its entry (written by an older
 * Portler) does not say which set.
 */
export function recordedVolumeSet(service: ServiceConfig | undefined, launch: PidServiceInfo | undefined): string | null | undefined {
  if (launch === undefined) return undefined;
  if (launch.volumeSet !== undefined) return launch.volumeSet;
  if (launch.dockerContainer === undefined) return undefined;
  return legacyMountCandidates(service, launch).length > 0 ? null : undefined;
}

/** How the stopped services were started, as one command line would repeat it. */
interface RecordedLaunch {
  runMode: RunMode;
  prod: boolean;
  noSetup: boolean;
  images: Record<string, string>;
  volumeSet: string | undefined;
}

/**
 * The single way the stopped services were started: the mode, `--prod`, `--no-setup`,
 * image pins and volume set their PID entries recorded (Kubernetes mode when this down
 * deleted them from the cluster). Undefined when there is no single way: they were started
 * differently, an entry does not say which volume set it was on, they were on the base
 * volumes while PORTLER_VOLUME_SET would make a plain command pick another set, or they ran
 * in Kubernetes, whose port-forward entries record no `--image` pin (and a service without a
 * port has no entry at all), so a command could quietly deploy another image.
 */
function recordedLaunch(
  serviceNames: readonly string[],
  launches: ReadonlyArray<PidServiceInfo | undefined>,
  mode: RunMode,
  volumeSets: ReadonlyArray<string | null | undefined>,
  envVolumeSet: string | undefined,
): RecordedLaunch | undefined {
  const modes = new Set<RunMode>();
  const prods = new Set<boolean>();
  const setups = new Set<boolean>();
  const images: Record<string, string> = {};
  serviceNames.forEach((serviceName, index) => {
    const launch = launches[index];
    modes.add(mode === 'k8s' ? 'k8s' : (launch?.runMode ?? mode));
    prods.add(launch?.prod === true);
    setups.add(launch?.setup !== false);
    if (launch?.image !== undefined) images[serviceName] = launch.image;
  });
  if (modes.size !== 1 || prods.size !== 1 || setups.size !== 1) return undefined;
  if (volumeSets.some((set) => set === null)) return undefined;
  const sets = new Set(volumeSets.filter((set): set is string => typeof set === 'string'));
  if (sets.size > 1) return undefined;
  const [volumeSet] = sets;
  if (volumeSet === '' && (envVolumeSet ?? '').trim() !== '') return undefined;
  const [runMode] = modes;
  if (runMode === 'k8s') return undefined;
  return { runMode: runMode!, prod: prods.has(true), noSetup: setups.has(false), images, volumeSet: volumeSet || undefined };
}

function launchFlags(launch: RecordedLaunch, file: string | undefined): string[] {
  const parts: string[] = [];
  if (file) parts.push('--file', shellQuote(file));
  if (launch.prod) parts.push('--prod');
  if (launch.noSetup) parts.push('--no-setup');
  for (const [service, image] of Object.entries(launch.images)) parts.push('--image', shellQuote(`${service}=${image}`));
  if (launch.volumeSet) parts.push('--volume-set', shellQuote(launch.volumeSet));
  return parts;
}

/**
 * The `up` that starts the stopped services again the way they were started, with this
 * invocation's `--file`. Undefined when no single `up` would (see recordedLaunch).
 */
export function upSuggestion(
  serviceNames: readonly string[],
  launches: ReadonlyArray<PidServiceInfo | undefined>,
  mode: RunMode,
  file: string | undefined,
  volumeSets: ReadonlyArray<string | null | undefined> = [],
  envVolumeSet: string | undefined = process.env.PORTLER_VOLUME_SET,
): string | undefined {
  const launch = recordedLaunch(serviceNames, launches, mode, volumeSets, envVolumeSet);
  if (!launch) return undefined;
  const parts = ['portler', 'up'];
  if (launch.runMode !== 'local') parts.push(launch.runMode);
  parts.push('-d', ...serviceNames.map(shellQuote), ...launchFlags(launch, file));
  return parts.join(' ');
}

/** A command that brings the stopped services back, and the launch it repeats when it is a `restart`. */
interface Recovery {
  command: string;
  restart: RecordedLaunch | undefined;
}

function recovery(
  serviceNames: readonly string[],
  launches: ReadonlyArray<PidServiceInfo | undefined>,
  mode: RunMode,
  file: string | undefined,
  volumeSets: ReadonlyArray<string | null | undefined>,
  runningPrerequisites: ReadonlyArray<PidServiceInfo | undefined>,
  envVolumeSet: string | undefined,
): Recovery | undefined {
  if (runningPrerequisites.length === 0) {
    const command = upSuggestion(serviceNames, launches, mode, file, volumeSets, envVolumeSet);
    return command === undefined ? undefined : { command, restart: undefined };
  }
  const launch = recordedLaunch(serviceNames, launches, mode, volumeSets, envVolumeSet);
  if (!launch) return undefined;
  const compatible = runningPrerequisites.every(
    (prerequisite) => prerequisite?.runMode === launch.runMode && (prerequisite.prod === true) === launch.prod,
  );
  if (!compatible) return undefined;
  const parts = ['portler', 'restart'];
  if (launch.runMode === 'docker') parts.push('docker');
  parts.push(...serviceNames.map(shellQuote), ...launchFlags(launch, file));
  return { command: parts.join(' '), restart: launch };
}

/**
 * The command that brings the stopped services back. `up` refuses when something the
 * services depend on is still running (it would start that too), so while a prerequisite
 * runs this is a `restart`, which starts what is stopped and leaves what runs alone.
 * Undefined when no command would do it: no single recorded launch (see recordedLaunch,
 * which also covers Kubernetes), or a running prerequisite started in another mode or with
 * another `--prod`, which restart refuses. A `restart` is still only offered once restart's
 * own plan accepts it (warnAboutDependents).
 */
export function recoveryCommand(
  serviceNames: readonly string[],
  launches: ReadonlyArray<PidServiceInfo | undefined>,
  mode: RunMode,
  file: string | undefined,
  volumeSets: ReadonlyArray<string | null | undefined>,
  runningPrerequisites: ReadonlyArray<PidServiceInfo | undefined>,
  envVolumeSet: string | undefined = process.env.PORTLER_VOLUME_SET,
): string | undefined {
  return recovery(serviceNames, launches, mode, file, volumeSets, runningPrerequisites, envVolumeSet)?.command;
}

/**
 * Whether `restart`, run as suggested, would plan and pass its checks without replaying
 * anything the command does not say. Its plan reads every entry recorded for what the
 * services depend on, a retained one whose process is gone included, so a mode or `--prod`
 * recorded there can make it refuse what the running prerequisites alone allow.
 */
async function restartWouldAccept(
  config: PortlerConfig,
  file: string | undefined,
  serviceNames: readonly string[],
  launch: RecordedLaunch,
  pids: PidsFile | null,
  running: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const loadedConfig = await loadConfig(config.projectDir, file, { volumeSet: launch.volumeSet });
    const request: RestartRequest = {
      mode: launch.runMode,
      requested: [...serviceNames],
      modeExplicit: launch.runMode === 'docker',
      prod: launch.prod ? true : undefined,
      setup: launch.noSetup ? false : undefined,
      images: Object.keys(launch.images).length > 0 ? launch.images : undefined,
    };
    return await restartAccepts(loadedConfig, request, pids, running);
  } catch {
    return false;
  }
}

/**
 * `down redis` stops only redis. Services that depend on it keep running and start failing
 * against it, so name them: the user can stop them too, or bring the dependency back.
 * A running service's dependencies are the ones it recorded when it started, because an
 * edited portler.yml says nothing about what is already running; entries that record none
 * (older ones, Kubernetes port-forwards) and services without one (`alsoRunning`: deployed in
 * the cluster without a port-forward) use the config.
 */
async function warnAboutDependents(
  config: PortlerConfig,
  stoppedNames: string[],
  before: PidsFile | null,
  mode: RunMode,
  file: string | undefined,
  retained: ReadonlySet<string>,
  alsoRunning: readonly string[] = [],
): Promise<void> {
  const stopped = new Set(stoppedNames);
  const pids = await readPids(config.projectDir);
  const live = [...new Set([...(await liveServiceNames(config.projectDir, pids)), ...alsoRunning])];
  const dependents: string[] = [];
  for (const name of live) {
    if (stopped.has(name)) continue;
    const dependencies =
      pids?.services[name]?.dependsOn ?? config.services[name]?.dependsOn.map((dependency) => dependency.service) ?? [];
    const on = dependencies.filter((dependency) => stopped.has(dependency));
    if (on.length > 0) dependents.push(`${name} (on ${on.join(', ')})`);
  }
  if (dependents.length === 0) return;

  const back = stoppedNames.filter((name) => name !== PROXY_SERVICE_NAME);
  const them = back.length === 1 ? 'it' : 'them';
  const launches = back.map((name) => before?.services[name]);
  const volumeSets = back.map((name, index) => recordedVolumeSet(config.services[name], launches[index]));
  // A service whose entry had to be kept is not fully stopped: starting it again now would be
  // refused, or would lose track of what is left of it. Name the dependents, offer no command.
  const unfinished = back.filter((name) => retained.has(name));
  const wasWere = back.length === 1 ? 'was' : 'were';
  let command: string | undefined;
  if (back.length > 0 && unfinished.length === 0) {
    // What the stopped services depend on and is still running: `up` would refuse it.
    let prerequisites: string[] | undefined;
    try {
      prerequisites = expandAndOrderServices(config, back).filter((name) => !stopped.has(name));
    } catch {
      prerequisites = undefined; // a stopped service no longer in portler.yml: nothing to suggest
    }
    if (prerequisites) {
      const liveNow = new Set(live);
      const running = prerequisites.filter((name) => liveNow.has(name)).map((name) => pids?.services[name]);
      const found = recovery(back, launches, mode, file, volumeSets, running, process.env.PORTLER_VOLUME_SET);
      if (found && (!found.restart || (await restartWouldAccept(config, file, back, found.restart, pids, liveNow)))) {
        command = found.command;
      }
    }
  }
  const fix =
    back.length === 0
      ? 'Stop them too.'
      : unfinished.length > 0
        ? `Stop them too; once ${unfinished.join(', ')} ${unfinished.length === 1 ? 'is' : 'are'} fully stopped (see below), start ${back.join(', ')} again the way ${them} ${wasWere} started.`
        : command
          ? `Stop them too, or bring ${them} back with "${command}".`
          : `Stop them too, or start ${back.join(', ')} again the way ${them} ${wasWere} started.`;
  process.stderr.write(`[portler] warning: still running and depending on what was stopped: ${dependents.join(', ')}. ${fix}\n`);
}

export async function commandDown(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(process.cwd(), args.file);
  const { mode, requested } = parseRunMode(args.positionals);

  if (mode !== 'k8s' && args.volumes) {
    throw new Error('--volumes only applies to "portler down k8s" (it deletes the cluster\'s PersistentVolumeClaims).');
  }

  const selectedNames = requested.length > 0 ? selectDownTargets(config, requested) : undefined;

  // The lifecycle lock makes this whole decision exclusive against a concurrent
  // up/restart in the same project: without it, `up` can read "api is not
  // running", and `down` can stop the api it is in the middle of starting.
  return withLifecycleLock(config.projectDir, async () => {
    // Stop the local processes first. This never touches a cluster, so it must
    // not be blocked by cluster problems: if kubectl is missing or the context
    // is unusable, the user's port-forwards are still stopped before they hear
    // about the cluster. Reservations remain until cluster deletion succeeds.
    // How the selected services were started, read before they stop: their entries go with them.
    const before = selectedNames ? await readPids(config.projectDir) : null;
    const result = await stopServices(config.projectDir, selectedNames, { force: args.force });

    // Deleting cluster resources DOES touch a cluster, so it is gated on the
    // context being a recognized local one, and every kubectl call is pinned
    // to it. PVCs (and the namespace) survive unless --volumes was passed, so
    // a database's data outlives an ordinary down/up cycle. If this fails, keep
    // every reservation: releasing ports while the requested teardown is only
    // half complete is the false all-clear the registry is meant to prevent.
    let deletedFromCluster: K8sDeleteResult = { deleted: false, services: [] };
    const cluster = mode === 'k8s' ? await detectCluster() : undefined;
    if (cluster) {
      deletedFromCluster = await deleteK8sResources(cluster, config, {
        serviceNames: selectedNames,
        deleteVolumes: args.volumes,
        awaitNamespace: true,
      });
    }

    await releasePorts(config.projectDir, releasableTargets(config, selectedNames, result));

    const incomplete = result.unverified.length > 0 || result.failures.length > 0;
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    } else if (!incomplete && !deletedFromCluster.deleted) {
      process.stdout.write('[portler] no running services found\n');
    }
    // A Kubernetes service without a port has no port-forward for stopServices to stop, but
    // deleting its Deployment takes it away from its dependents all the same (one that was not
    // deployed is taken from no one).
    // So does removing a Docker service's running container, even when its entry is kept
    // because a leftover `docker run` client still holds the group.
    const takenAway = [
      ...new Set([
        ...result.stopped,
        ...result.containersRemoved,
        ...deletedFromCluster.services.filter((name) => name !== PROXY_SERVICE_NAME),
      ]),
    ];
    if (selectedNames && takenAway.length > 0) {
      // A Kubernetes service without a port has no port-forward, and so no entry to find it
      // by: the cluster says whether it still runs.
      const deployed = cluster ? ((await deployedK8sServices(cluster, config)) ?? []) : [];
      await warnAboutDependents(config, takenAway, before, mode, args.file, new Set(result.remaining), deployed);
    }

    // Exit non-zero when down did NOT finish the job: a service is only
    // "stopped" once its process group is confirmed gone, so what is left here
    // is still running (or a Docker resource is still there). Reporting success
    // would tell a script the project is down when it is not.
    if (result.unverified.length > 0) {
      process.stderr.write(
        `[portler] down did not stop: ${result.unverified.join(', ')} (identity not verified — see the warnings above). ` +
          'Their PID entries were kept.\n',
      );
    }
    if (result.failures.length > 0) {
      for (const failure of result.failures) process.stderr.write(`[portler] ${failure}\n`);
      process.stderr.write(
        `[portler] ${result.failures.length} teardown failure(s); re-run "portler down" once the cause is fixed.\n`,
      );
    }

    return incomplete ? 1 : 0;
  });
}
