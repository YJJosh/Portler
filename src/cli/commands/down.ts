import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { type ClusterInfo, deleteK8sResources, deployedK8sServices, forgetLaunchContext, type K8sDeleteResult, launchCluster } from '../../k8s/index.ts';
import { releasePorts } from '../../ports/index.ts';
import type { RunMode } from '../../config/index.ts';
import { shellQuote } from '../../process/docker.ts';
import { liveServiceNames, readPids, stopServices } from '../../process/index.ts';
import type { StopResult } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, selectServiceTargets, servicesWithPorts } from '../services.ts';
import { legacyMountCandidates, restartAccepts, type RestartRequest } from './restart.ts';

function releaseTargets(config: PortlerConfig, selectedNames: string[]): string[] {
  const serviceNames = servicesWithPorts(
    config,
    selectedNames.filter((name) => name !== PROXY_SERVICE_NAME),
  );
  if (config.proxy && selectedNames.includes(PROXY_SERVICE_NAME)) serviceNames.push(PROXY_SERVICE_NAME);
  return serviceNames;
}

// Skips targets still recorded as incomplete and adds completed stale entries of services gone from
// the config, so a full `down` cleans old registry entries without giving back a live service's port.
function releasableTargets(config: PortlerConfig, selectedNames: string[] | undefined, result: StopResult): string[] {
  const configured = releaseTargets(
    config,
    selectedNames ?? [...Object.keys(config.services), ...(config.proxy ? [PROXY_SERVICE_NAME] : [])],
  );
  const remaining = new Set(result.remaining);
  return [...new Set([...configured, ...result.completed])].filter((name) => !remaining.has(name));
}

/** The recorded set (`''` for the base volumes); undefined when the service mounts no `@` volume
 * in its mode, null when it does but its entry does not say which set. */
export function recordedVolumeSet(service: ServiceConfig | undefined, launch: PidServiceInfo | undefined): string | null | undefined {
  if (launch === undefined) return undefined;
  if (launch.volumeSet !== undefined) return launch.volumeSet;
  if (launch.dockerContainer === undefined) return undefined;
  return legacyMountCandidates(service, launch).length > 0 ? null : undefined;
}

// How the stopped services were started, as one command line would repeat it.
interface RecordedLaunch {
  runMode: RunMode;
  prod: boolean;
  noSetup: boolean;
  images: Record<string, string>;
  volumeSet: string | undefined;
}

// Undefined if they were started differently, an entry lacks its volume set, PORTLER_VOLUME_SET would
// move a plain command off the base volumes, or they ran in k8s (no `--image` pin is recorded there,
// so the command could deploy another image).
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

/** The `up` that starts the stopped services again as they were started, with this `--file`;
 * undefined when no single `up` would. */
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

// `restart` is the launch the command repeats when it is a `restart`.
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

/** A `restart` while a prerequisite runs (`up` refuses then), else an `up`. Undefined without one
 * recorded launch, or with a running prerequisite in another mode or `--prod`, which restart refuses. */
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

// restart's plan also reads retained entries of dead prerequisites, whose mode or `--prod` can
// make it refuse a command recovery() offers.
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

// A running service's dependencies come from its entry, since an edited portler.yml says nothing about
// what runs; entries without them (k8s port-forwards) and `alsoRunning` (cluster-only) use the config.
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

  const selectedNames = requested.length > 0 ? selectServiceTargets(config, requested) : undefined;

  // Without the lock, `up` can read "api is not running" while `down` stops the api it is starting.
  return withLifecycleLock(config.projectDir, async () => {
    // Local processes stop first, so kubectl problems cannot keep port-forwards running; reservations
    // stay until the cluster delete succeeds. Entries are read before they go with the services.
    const before = selectedNames ? await readPids(config.projectDir) : null;
    const result = await stopServices(config.projectDir, selectedNames, { force: args.force });

    // Cluster deletes need a recognized local context: the one `up k8s` recorded, not the active one,
    // pinned on every kubectl call. PVCs and the namespace survive unless --volumes. On failure keep
    // every reservation: freeing ports after a half-done teardown is a false all-clear.
    let deletedFromCluster: K8sDeleteResult = { deleted: false, services: [] };
    let cluster: ClusterInfo | undefined;
    if (mode === 'k8s') {
      const launch = await launchCluster(config.projectDir);
      if (launch.source === 'gone') {
        // No kubectl call can reach that cluster through this kubeconfig any more.
        process.stderr.write(
          `[portler] warning: kubectl context "${launch.context}", where "portler up k8s" started this project, no longer ` +
            'exists, so nothing was deleted from a cluster; forgetting it\n',
        );
        await forgetLaunchContext(config.projectDir);
      } else {
        cluster = launch.cluster;
        if (launch.source === 'recorded') {
          process.stdout.write(`[portler] kubectl context: ${cluster.context} (${cluster.type}), where "portler up k8s" started this project\n`);
        }
        deletedFromCluster = await deleteK8sResources(cluster, config, {
          serviceNames: selectedNames,
          deleteVolumes: args.volumes,
          awaitNamespace: true,
        });
        // The whole project is gone from that cluster: the next `up k8s` may start anywhere.
        if (!selectedNames) await forgetLaunchContext(config.projectDir);
      }
    }

    await releasePorts(config.projectDir, releasableTargets(config, selectedNames, result));

    const incomplete = result.unverified.length > 0 || result.failures.length > 0;
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    } else if (!incomplete && !deletedFromCluster.deleted) {
      process.stdout.write('[portler] no running services found\n');
    }
    // Dependents also lose a port-less k8s service whose Deployment was deleted, and a Docker service
    // whose container was removed while its entry is kept (a leftover `docker run` client holds the group).
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

    // A service is "stopped" only once its process group is confirmed gone, so what is left
    // still runs (or a Docker resource remains): exit non-zero so a script does not assume down.
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
