import { configForRunMode, loadBaseEnv, loadConfig, managedVolumeMount, managedVolumeName, type RunMode } from '../../config/index.ts';
import { productionServices } from '../../config/production.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertEnvRequirements } from '../../env/index.ts';
import { K8S_FORWARD_COMMAND } from '../../k8s/index.ts';
import { liveServiceNames, mountedVolumeSet, readPids, stopServices, type MountedVolumeSet } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import type { PidServiceInfo, PidsFile, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import { expandAndOrderServices, parseRunMode, recordedRunMode, selectServiceNames, validateImageOverrideTargets } from '../services.ts';
import { checkLaunch, launchConfig, StartSetChangedError, startPhase } from './up.ts';

export interface RestartLaunch {
  prod: boolean;
  mode: RunMode;
  images: Record<string, string>;
  setup: boolean | undefined;
  /** The volume set the managed volumes are mounted from; undefined for the base volumes. */
  volumeSet: string | undefined;
  /** What was taken from pids.json rather than from the command line, for the notice. */
  replayed: string[];
  /** Recorded pins that do not apply in the chosen run mode (the service is not a container there). */
  droppedPins: string[];
}

export interface RestartPlanInput {
  rawConfig: PortlerConfig;
  /** Every recorded entry, live or stale. */
  running: Readonly<Record<string, PidServiceInfo>>;
  /** Names whose process is alive. */
  runningNow: ReadonlySet<string>;
  /** Recorded names this restart stops. */
  stopping: readonly string[];
  /** Recorded names this restart touches: the ones it stops and the dependencies it leaves running. */
  involved: readonly string[];
  /** Names startPhase will start again. */
  starting: readonly string[];
  requestedMode: RunMode;
  modeExplicit: boolean;
  prod: boolean | undefined;
  setup: boolean | undefined;
  images: Readonly<Record<string, string>> | undefined;
  /** Whether --volume-set or PORTLER_VOLUME_SET chose the set (rawConfig.volumeSet); then nothing is replayed. */
  volumeSetGiven: boolean;
  /** For containers recorded without a set: the set their volumes show ('' for the base volumes),
   * null when unreadable. An absent name mounts no managed volume. */
  mountedVolumeSets?: Readonly<Record<string, string | null>>;
}

const KUBERNETES_RESTART_HINT =
  'Run "portler down k8s" followed by "portler up k8s" instead ' +
  '(a k8s restart has to re-apply manifests and re-establish port-forwards, which restart does not do).';

function list(names: readonly string[]): string {
  return names.join(', ');
}

function verb(names: readonly string[], singular: string, plural: string): string {
  return names.length === 1 ? singular : plural;
}

function withVolumeSet(config: PortlerConfig, launch: RestartLaunch): PortlerConfig {
  return launch.volumeSet === config.volumeSet ? config : { ...config, volumeSet: launch.volumeSet };
}

/** Replays what pids.json recorded (--prod, run mode, --image pins, --no-setup, volume set); flags
 * override it for the restarted services. Throws if a dependency left running is in another mode. */
export function planRestart(input: RestartPlanInput): RestartLaunch {
  const { rawConfig, running, runningNow, involved, starting } = input;
  const entry = (name: string): PidServiceInfo => {
    const info = running[name];
    if (info === undefined) throw new Error(`restart: no recorded entry for ${name}`);
    return info;
  };
  const stoppingSet = new Set(input.stopping);
  const restarted = involved.filter((name) => stoppingSet.has(name));
  const leftAlone = involved.filter((name) => !stoppingSet.has(name) && runningNow.has(name));
  const replayed: string[] = [];

  // An `up k8s` entry is the port-forward: relaunching it as a local process would leave the
  // cluster workload as it was. Entries without runMode are known by the forward's command.
  const kubernetes = involved.filter((name) => {
    const info = entry(name);
    return info.runMode === 'k8s' || info.command.startsWith(`${K8S_FORWARD_COMMAND} `);
  });
  if (kubernetes.length > 0) {
    throw new Error(
      `${list(kubernetes)} ${verb(kubernetes, 'was', 'were')} started with "portler up k8s", and restart does not support Kubernetes mode. ` +
        KUBERNETES_RESTART_HINT,
    );
  }

  const localConfig = configForRunMode(rawConfig, 'local');
  const recordedMode = (name: string): RunMode | undefined => recordedRunMode(localConfig, name, entry(name));
  const modeWord = (prod: boolean): string => (prod ? 'production' : 'development');

  let prod: boolean;
  if (input.prod === true) {
    prod = true;
  } else {
    const modes = new Set(involved.map((name) => entry(name).prod === true));
    if (modes.size > 1) {
      const prodNames = involved.filter((name) => entry(name).prod === true);
      const devNames = involved.filter((name) => entry(name).prod !== true);
      throw new Error(
        `${list(prodNames)} ${verb(prodNames, 'was', 'were')} started with --prod and ${list(devNames)} in development mode, ` +
          'so there is no one mode to replay. Pass --prod to restart everything in production mode, or run "portler down" and then "portler up" to start over.',
      );
    }
    prod = modes.has(true);
    if (prod) replayed.push('--prod');
  }

  let mode: RunMode;
  if (input.modeExplicit) {
    mode = input.requestedMode;
  } else {
    const modes = new Set(involved.map(recordedMode).filter((recorded) => recorded !== undefined));
    if (modes.size > 1) {
      const dockerNames = involved.filter((name) => recordedMode(name) === 'docker');
      const localNames = involved.filter((name) => recordedMode(name) === 'local');
      throw new Error(
        `${list(dockerNames)} ${verb(dockerNames, 'was', 'were')} started in Docker mode and ${list(localNames)} as ${verb(localNames, 'a local process', 'local processes')}, ` +
          'so there is no one run mode to replay. Pass "docker" to restart in Docker mode, or run "portler down" and then "portler up" to start over.',
      );
    }
    mode = input.requestedMode;
    for (const recorded of modes) mode = recorded;
    if (mode === 'docker') replayed.push('docker');
  }

  // Nothing this restart leaves running may end up next to the restarted
  // services in the other mode: its command, env and addresses would not match.
  const restartedText = restarted.length > 0 ? list(restarted) : 'the restarted services';
  const otherProd = leftAlone.filter((name) => (entry(name).prod === true) !== prod);
  if (otherProd.length > 0) {
    const flag = prod ? ' --prod' : '';
    throw new Error(
      `${list(otherProd)} ${verb(otherProd, 'is', 'are')} running in ${modeWord(!prod)} mode, and this restart would leave ${verb(otherProd, 'it', 'them')} there next to ` +
        `${restartedText} in ${modeWord(prod)} mode. Restart ${verb(otherProd, 'it', 'them')} as well ("portler restart${flag}" with no names restarts everything), ` +
        `or run "portler down" and then "portler up${flag}" to switch modes.`,
    );
  }
  const otherMode = leftAlone.filter((name) => {
    const recorded = recordedMode(name);
    return recorded !== undefined && recorded !== mode;
  });
  if (otherMode.length > 0) {
    const dockerFlag = mode === 'docker' ? ' docker' : '';
    const theirs = mode === 'docker' ? 'as a local process' : 'in Docker mode';
    const ours = mode === 'docker' ? 'in Docker mode' : 'as local processes';
    throw new Error(
      `${list(otherMode)} ${verb(otherMode, 'is', 'are')} running ${theirs}, and this restart would run ${restartedText} ${ours} next to ${verb(otherMode, 'it', 'them')}; ` +
        `Portler does not mix the two in one stack. Restart ${verb(otherMode, 'it', 'them')} as well ("portler restart${dockerFlag}" with no names restarts everything), ` +
        `or run "portler down" and then "portler up${dockerFlag}".`,
    );
  }

  // A recorded pin is replayed unless the command pins the service anew, and only where it is a
  // container in the chosen run mode; elsewhere the flag would change nothing.
  const modeConfig = configForRunMode(rawConfig, mode);
  const images: Record<string, string> = {};
  const droppedPins: string[] = [];
  for (const name of starting) {
    const pin = Object.hasOwn(running, name) ? entry(name).image : undefined;
    if (pin === undefined || (input.images !== undefined && Object.hasOwn(input.images, name))) continue;
    if (modeConfig.services[name]?.docker === undefined) {
      droppedPins.push(name);
      continue;
    }
    images[name] = pin;
    replayed.push(`--image ${name}=${pin}`);
  }
  Object.assign(images, input.images ?? {});

  // startPhase takes one setup choice, so every recorded service started again, a returning
  // dead dependency included, must agree, or one's --no-setup would skip another's steps.
  let setup = input.setup;
  if (setup === undefined) {
    const recorded = starting.filter((name) => Object.hasOwn(running, name));
    const skipped = recorded.filter((name) => entry(name).setup === false);
    const withSetup = recorded.filter((name) => entry(name).setup !== false);
    if (skipped.length > 0 && withSetup.length > 0) {
      throw new Error(
        `${list(skipped)} ${verb(skipped, 'was', 'were')} started with --no-setup and ${list(withSetup)} with ${verb(withSetup, 'its', 'their')} setup steps, ` +
          'so there is no one setup choice to replay. Pass --setup or --no-setup to choose for every service this restart starts.',
      );
    }
    if (skipped.length > 0) {
      setup = false;
      replayed.push('--no-setup');
    }
  }

  // Replayed, or a database started on `--volume-set branch` comes back on other data. Recorded
  // containers mounting an `@` volume here vote, by recorded set, else mounted set (unreadable: refused).
  let volumeSet = rawConfig.volumeSet;
  if (!input.volumeSetGiven) {
    const mounted = input.mountedVolumeSets ?? {};
    const voted = new Map<string, string>();
    const unknown: string[] = [];
    for (const name of starting) {
      if (!Object.hasOwn(running, name)) continue;
      const info = entry(name);
      if (info.dockerContainer === undefined) continue;
      if (!(modeConfig.services[name]?.docker?.volumes ?? []).some((volume) => managedVolumeName(volume) !== undefined)) continue;
      const set = info.volumeSet !== undefined ? info.volumeSet : Object.hasOwn(mounted, name) ? mounted[name] : undefined;
      if (set === null) unknown.push(name);
      else if (set !== undefined) voted.set(name, set);
    }
    if (unknown.length > 0) {
      throw new Error(
        `${list(unknown)} ${verb(unknown, 'was', 'were')} started by an older Portler, which did not record the volume set, and ` +
          `${verb(unknown, 'its container does', 'their containers do')} not show which set ${verb(unknown, 'it mounts', 'they mount')}. ` +
          `Pass --volume-set <name> to start ${verb(unknown, 'it', 'them')} on that set, or run "portler down ${unknown.join(' ')}" ` +
          `first to start ${verb(unknown, 'it', 'them')} on the base volumes.`,
      );
    }
    const sets = [...new Set(voted.values())];
    if (sets.length > 1) {
      const groups = sets.map((set) => {
        const names = [...voted.keys()].filter((name) => voted.get(name) === set);
        return `${list(names)} on ${set ? `volume set "${set}"` : 'the base volumes'}`;
      });
      throw new Error(
        `this restart would start ${groups.join(' and ')} again, so there is no one volume set to replay. ` +
          'Pass --volume-set to mount one set for all of them, or restart them in separate commands.',
      );
    }
    if (sets[0]) {
      volumeSet = sets[0];
      replayed.push(`--volume-set ${volumeSet}`);
    }
  }

  return { prod, mode, images, setup, volumeSet, replayed, droppedPins };
}

type ManagedMount = { name: string; destination: string };

function managedMounts(volumes: readonly string[] | undefined): ManagedMount[] {
  return (volumes ?? []).flatMap((volume) => {
    const mount = managedVolumeMount(volume);
    return mount === undefined ? [] : [mount];
  });
}

/** One `@` mount list per run mode the container may have run in (every mode without runMode); not
 * merged, since the `docker:` override can mount other volumes at the same path. */
export function legacyMountCandidates(service: ServiceConfig | undefined, info: PidServiceInfo): ManagedMount[][] {
  if (service === undefined) return [];
  const local = managedMounts(service.docker?.volumes);
  const docker = managedMounts((service.dockerModeOverride ?? service.docker)?.volumes);
  let lists: ManagedMount[][];
  if (info.runMode === 'local') lists = [local];
  else if (info.runMode === 'docker') lists = [docker];
  else if (info.runMode !== undefined) lists = [];
  else if (service.docker === undefined) lists = [docker];
  else lists = service.dockerModeOverride === undefined ? [local] : [local, docker];
  const seen = new Set<string>();
  return lists.filter((list) => {
    const key = JSON.stringify(list);
    if (list.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** null when the set cannot be told (an inspection failed, or the modes disagree); undefined when
 * no mode finds a managed volume. */
export function combineMountedSets(found: readonly MountedVolumeSet[]): string | null | undefined {
  if (found.some((result) => result.status === 'unknown')) return null;
  const sets = new Set(found.flatMap((result) => (result.status === 'set' ? [result.set] : [])));
  if (sets.size === 0) return undefined;
  return sets.size === 1 ? [...sets][0]! : null;
}

/** The parsed restart command line. */
export interface RestartRequest {
  mode: RunMode;
  /** The service names given (none: everything recorded). */
  requested: string[];
  /** Whether the run mode was typed (`restart docker …`) rather than defaulted. */
  modeExplicit: boolean;
  prod: boolean | undefined;
  setup: boolean | undefined;
  images: Record<string, string> | undefined;
}

// Before the lock. Under --prod a service prod.services leaves out is the deployment's, as for
// `up --prod`, so naming one is refused; prepareRestart narrows the same way for a replayed --prod.
function restartTarget(loadedConfig: PortlerConfig, request: RestartRequest): PortlerConfig {
  // Only `up` routes k8s mode to commandUpK8s: restart would run the k8s overlay as local
  // processes and apply nothing to the cluster.
  if (request.mode === 'k8s') {
    throw new Error(`restart does not support Kubernetes mode. ${KUBERNETES_RESTART_HINT}`);
  }
  const explicitConfig = productionServices(loadedConfig, request.prod, request.requested);
  selectServiceNames(explicitConfig, request.requested);
  return explicitConfig;
}

// So a restart does not take containers recorded without a set for the base volumes.
async function legacyVolumeSets(
  loadedConfig: PortlerConfig,
  running: Readonly<Record<string, PidServiceInfo>>,
): Promise<Record<string, string | null>> {
  const mountedVolumeSets: Record<string, string | null> = {};
  if (loadedConfig.volumeSet !== undefined) return mountedVolumeSets;
  await Promise.all(
    Object.entries(running).map(async ([serviceName, info]) => {
      if (info.volumeSet !== undefined || info.dockerContainer === undefined) return;
      const candidates = legacyMountCandidates(loadedConfig.services[serviceName], info);
      if (candidates.length === 0) return;
      // Volumes are labelled with the volume root, or the project's name for a named
      // production stack. Production volumes made without `name:` carry the volume root, so it always counts.
      const owners = [loadedConfig.volumeRoot, ...(info.prod === true && loadedConfig.name ? [loadedConfig.name] : [])];
      const found = await Promise.all(
        candidates.map((expected) => mountedVolumeSet(info.dockerContainer!, loadedConfig.projectDir, expected, owners)),
      );
      const set = combineMountedSets(found);
      if (set !== undefined) mountedVolumeSets[serviceName] = set;
    }),
  );
  return mountedVolumeSets;
}

// Everything decided before the stop, from pids.json read under the lock. `planFor` and
// `startingFor` plan again after the stop.
async function prepareRestart(
  loadedConfig: PortlerConfig,
  request: RestartRequest,
  before: PidsFile | null,
  runningNow: ReadonlySet<string>,
) {
  const { mode, requested } = request;
  const explicitConfig = restartTarget(loadedConfig, request);
  const running = before?.services ?? {};
  const mountedVolumeSets = await legacyVolumeSets(loadedConfig, running);
  const scope = (config: PortlerConfig) => {
    const requestedRootNames = selectServiceNames(config, requested);
    // Without names every recorded service stops and counts, also ones gone from the
    // config. The proxy's entry is Portler's own and carries no mode.
    const stopping = requested.length > 0 ? requestedRootNames : Object.keys(running).filter((name) => name !== PROXY_SERVICE_NAME);
    const involved = [...new Set([...expandAndOrderServices(config, requestedRootNames), ...stopping])].filter(
      (name) => Object.hasOwn(running, name),
    );
    return { requestedRootNames, stopping, involved };
  };
  // liveNow is read before the stop and again after it, since a dependency can exit on its
  // own in between. The records stay the ones read before, which hold the stopped launches.
  const startingFor = (config: PortlerConfig, liveNow: ReadonlySet<string>) => {
    const { requestedRootNames, stopping, involved } = scope(config);
    const stoppingSet = new Set(stopping);
    const starting = expandAndOrderServices(config, requestedRootNames).filter(
      (serviceName) => !liveNow.has(serviceName) || stoppingSet.has(serviceName),
    );
    return { requestedRootNames, stopping, involved, starting };
  };
  const planFor = (config: PortlerConfig, prod: boolean | undefined, liveNow: ReadonlySet<string> = runningNow) => {
    const { requestedRootNames, stopping, involved, starting } = startingFor(config, liveNow);
    const launch = planRestart({
      rawConfig: config,
      running,
      runningNow: liveNow,
      stopping,
      involved,
      starting,
      requestedMode: mode,
      modeExplicit: request.modeExplicit,
      prod,
      setup: request.setup,
      images: request.images,
      volumeSetGiven: loadedConfig.volumeSet !== undefined,
      mountedVolumeSets,
    });
    return { requestedRootNames, starting, launch };
  };
  // A replayed --prod narrows to prod.services like a typed one, decided on the narrowed stack (a dev
  // copy of a left-out service has no say). The proxy is skipped only here; its routes are still checked.
  let rawConfig = explicitConfig;
  const listed = loadedConfig.prod?.services;
  if (
    !request.prod &&
    listed !== undefined &&
    requested.every((name) => !Object.hasOwn(loadedConfig.services, name) || listed.includes(name))
  ) {
    const { involved } = scope(productionServices({ ...loadedConfig, proxy: undefined }, true, requested));
    if (involved.length > 0 && involved.every((name) => running[name]?.prod === true)) {
      rawConfig = productionServices(loadedConfig, true, requested);
    }
  }
  let planProd = request.prod;
  let { requestedRootNames, starting, launch } = planFor(rawConfig, planProd);
  // The look above skips a name prod.services drops, or a stack whose narrowed records are gone, which
  // can still replay --prod: plan on the narrowed stack, so a dropped name is refused before the stop.
  if (launch.prod && request.prod !== true && rawConfig === explicitConfig) {
    rawConfig = productionServices(loadedConfig, true, requested);
    const replayedProd = launch.replayed.includes('--prod');
    planProd = true;
    ({ requestedRootNames, starting, launch } = planFor(rawConfig, planProd));
    if (replayedProd) launch.replayed.unshift('--prod');
  }

  // startPhase's checks, run before the stop on the config it will run: a failure after the stop would
  // leave the services down (run mode, commands, container names, --image targets, required env).
  const finalConfig = rawConfig;
  const preflight = async (plan: RestartLaunch, names: string[], liveNow: ReadonlySet<string>): Promise<void> => {
    const { config: runConfig } = launchConfig(withVolumeSet(finalConfig, plan), plan.mode, { prod: plan.prod, images: plan.images });
    checkLaunch(runConfig, plan.mode, names);
    if (Object.keys(plan.images).length > 0) validateImageOverrideTargets(plan.images, names, liveNow);
    assertEnvRequirements(runConfig, names, await loadBaseEnv(runConfig, { allowMissing: plan.prod }), {
      projectSetup: plan.setup !== false,
    });
  };
  return { rawConfig, planProd, requestedRootNames, starting, launch, planFor, startingFor, preflight };
}

/** True when this restart would plan without refusing, replay nothing the request does not say,
 * and pass its pre-stop checks; `up` offers a restart instead of a refusal only then. */
export async function restartAccepts(
  loadedConfig: PortlerConfig,
  request: RestartRequest,
  before: PidsFile | null,
  runningNow: ReadonlySet<string>,
): Promise<boolean> {
  try {
    const prepared = await prepareRestart(loadedConfig, request, before, runningNow);
    if (prepared.launch.replayed.length > 0 || prepared.launch.droppedPins.length > 0) return false;
    await prepared.preflight(prepared.launch, prepared.starting, runningNow);
    return true;
  } catch {
    return false;
  }
}

/** Stops the requested services (all by default) and starts them again detached, without releasing
 * their ports in between. Stopped dependencies start too; running ones are left alone. */
export async function commandRestart(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  const loadedConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });
  const request: RestartRequest = {
    mode,
    requested,
    modeExplicit: args.positionals.length > requested.length,
    prod: args.prod,
    setup: args.setup,
    images: args.images,
  };
  restartTarget(loadedConfig, request);

  // One lock for stop and start: in between, another `up` could start the services and this
  // restart start them again. restart always detaches, so the lock ends with startup.
  return withLifecycleLock(loadedConfig.projectDir, async () => {
    const before = await readPids(loadedConfig.projectDir);
    // Running as startPhase will see it (liveServiceNames): a dependency whose container runs
    // on after its `docker run` shell is gone is running and left alone, not started again.
    const runningNow = new Set(await liveServiceNames(loadedConfig.projectDir, before));
    const prepared = await prepareRestart(loadedConfig, request, before, runningNow);
    const { rawConfig, planProd, planFor, startingFor, preflight } = prepared;
    let { requestedRootNames, starting, launch } = prepared;
    if (launch.replayed.length > 0) {
      process.stdout.write(`[portler] restart keeps the recorded launch: ${launch.replayed.join(', ')}\n`);
    }
    for (const name of launch.droppedPins) {
      process.stdout.write(`[portler] ${name}: the recorded image pin does not apply in this run mode and is dropped\n`);
    }
    await preflight(launch, starting, runningNow);

    // With no names, stop everything in pids.json, as `down` does, so services removed
    // from the config do not linger.
    const result = await stopServices(rawConfig.projectDir, requested.length > 0 ? requestedRootNames : undefined);
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    }

    // A service not confirmed stopped still runs and holds its port (its identity was not
    // proven, or teardown failed): refuse rather than start a second copy, as `down` does.
    if (result.unverified.length > 0 || result.failures.length > 0) {
      const stuck = [...result.unverified, ...result.failures];
      throw new Error(
        `restart could not stop: ${stuck.join('; ')} — those services are (or may still be) running, so restart will ` +
          'not start a second copy on top of them. Stop them yourself: check each pid with ' +
          '"ps -o pid,ppid,lstart,command -p <pid>" and, once you have confirmed it is your service, stop it ' +
          '("kill -TERM -<pid>" signals its whole process group), then re-run restart.',
      );
    }

    // The lock keeps out Portler commands, not a dependency exiting on its own, which startPhase would
    // start unchecked with this launch instead of its recorded one. So re-plan from what runs now;
    // startPhase refuses what the plan does not cover (StartSetChangedError), and this plans again.
    const stoppedText = result.stopped.length > 0 ? list(result.stopped) : 'the requested services';
    const stoppedVerb = result.stopped.length === 1 ? 'is' : 'are';
    for (let attempt = 1; ; attempt += 1) {
      const liveNow = new Set(await liveServiceNames(rawConfig.projectDir, await readPids(rawConfig.projectDir)));
      const startingNow = startingFor(rawConfig, liveNow).starting;
      const planned = new Set(starting);
      const exited = startingNow.filter((name) => !planned.has(name));
      if (exited.length > 0 || startingNow.length !== starting.length) {
        const what =
          exited.length > 0
            ? `${list(exited)} exited on ${verb(exited, 'its', 'their')} own while restart was stopping ${stoppedText}`
            : `the services to start changed while restart was stopping ${stoppedText}`;
        let next: ReturnType<typeof planFor>;
        try {
          next = planFor(rawConfig, planProd, liveNow);
          await preflight(next.launch, next.starting, liveNow);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${what}, and starting again is refused: ${reason} Nothing was started, so ${stoppedText} ${stoppedVerb} stopped.`);
        }
        if (exited.length > 0) process.stdout.write(`[portler] ${what}; starting ${verb(exited, 'it', 'them')} again too\n`);
        const added = next.launch.replayed.filter((item) => !launch.replayed.includes(item));
        if (added.length > 0) process.stdout.write(`[portler] restart keeps the recorded launch: ${added.join(', ')}\n`);
        for (const name of next.launch.droppedPins.filter((pinned) => !launch.droppedPins.includes(pinned))) {
          process.stdout.write(`[portler] ${name}: the recorded image pin does not apply in this run mode and is dropped\n`);
        }
        ({ starting, launch } = next);
      }
      try {
        await startPhase(withVolumeSet(rawConfig, launch), launch.mode, requestedRootNames, {
          detach: true,
          skipRunning: true,
          prod: launch.prod,
          ...(launch.setup !== undefined ? { setup: launch.setup } : {}),
          images: launch.images,
          expectStart: starting,
        });
        return 0;
      } catch (error) {
        if (!(error instanceof StartSetChangedError)) throw error;
        if (attempt >= 3) {
          throw new Error(
            `services kept exiting while restart was starting them (${error.message}); nothing was started, so ${stoppedText} ` +
              `${stoppedVerb} stopped. Run "portler restart" again.`,
          );
        }
      }
    }
  });
}
