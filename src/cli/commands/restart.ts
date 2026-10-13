import { applyImageOverrides, configForRunMode, loadBaseEnv, loadConfig, type RunMode } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertProductionRequirements } from '../../env/index.ts';
import { readPids, runningServices, stopServices } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import type { PidServiceInfo, PortlerConfig } from '../../types/index.ts';
import { expandAndOrderServices, parseRunMode, selectServiceNames, validateImageOverrideTargets } from '../services.ts';
import { startPhase } from './up.ts';

export interface RestartLaunch {
  prod: boolean;
  mode: RunMode;
  images: Record<string, string>;
  setup: boolean | undefined;
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
}

function list(names: readonly string[]): string {
  return names.join(', ');
}

function verb(names: readonly string[], singular: string, plural: string): string {
  return names.length === 1 ? singular : plural;
}

/**
 * Decide how a restart launches the services it starts again. pids.json records
 * how each service was started (--prod, the run mode, an --image pin,
 * --no-setup); without flags the restart replays that, so a routine
 * `portler restart api` on a production Docker stack comes back as a production
 * container with the same pin and without setup steps. Flags override for the
 * services being restarted. What the restart leaves running has to agree with
 * the result: a dependency left in the other mode, or started in the other run
 * mode, is refused here, before anything is stopped. Restarting everything may
 * switch the whole stack, since nothing is left behind.
 */
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

  // Entries without runMode predate the field. A container of a service whose
  // docker: block only applies under `up docker` must have come from docker
  // mode; anything else counts as local, the conservative reading.
  const localConfig = configForRunMode(rawConfig, 'local');
  const recordedMode = (name: string): RunMode => {
    const info = entry(name);
    if (info.runMode !== undefined) return info.runMode;
    return info.dockerContainer !== undefined && localConfig.services[name]?.docker === undefined ? 'docker' : 'local';
  };
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
    const modes = new Set(involved.map(recordedMode));
    if (modes.size > 1) {
      const dockerNames = involved.filter((name) => recordedMode(name) === 'docker');
      const localNames = involved.filter((name) => recordedMode(name) !== 'docker');
      throw new Error(
        `${list(dockerNames)} ${verb(dockerNames, 'was', 'were')} started in Docker mode and ${list(localNames)} as local ${verb(localNames, 'process', 'processes')}, ` +
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
  const otherMode = leftAlone.filter((name) => recordedMode(name) !== mode);
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

  // A recorded pin is replayed for a service this restart starts again, unless
  // the command pins it anew, and only where the service is a container in the
  // chosen run mode; elsewhere it would be a flag that changes nothing.
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

  // Setup is one choice for the whole start (startPhase takes one value), so
  // every recorded service this restart starts again has to agree on it,
  // including a dead dependency that comes back; otherwise one service's
  // --no-setup would skip another's setup steps, or the reverse.
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

  return { prod, mode, images, setup, replayed, droppedPins };
}

/**
 * Restart services: stop the requested services (all by default), then start
 * them again in the background. Ports are deliberately NOT released in
 * between, so allocateAssignments reclaims the previous registry
 * reservations and services keep their ports whenever they are still free.
 * Dependencies that are not running are started too; dependencies that are
 * still running are left untouched. Without flags the restart replays how the
 * services were started (--prod, the run mode, --image pins, --no-setup), as
 * recorded in pids.json; `--prod`, `docker`, `--image` and `--setup`/
 * `--no-setup` override that for the services it starts again. See planRestart.
 */
export async function commandRestart(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  const loadedConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });

  // `restart k8s` used to be accepted and then quietly do the wrong thing: it
  // applied the k8s config overlay (k8s.env, in-cluster DNS hostnames) but ran
  // the services as LOCAL processes, because only `up` routes k8s mode to
  // commandUpK8s. Nothing was ever applied to the cluster. Reject it instead of
  // guessing which half the user meant.
  if (mode === 'k8s') {
    throw new Error(
      'restart does not support Kubernetes mode. Run "portler down k8s" followed by "portler up k8s" instead ' +
        '(a k8s restart has to re-apply manifests and re-establish port-forwards, which restart does not do).',
    );
  }

  // Under --prod the services prod.services leaves out are the deployment's, as for
  // `up --prod`: naming one is refused and none is stopped or started. A --prod that is
  // replayed from pids.json narrows the same way once the plan has read it (below).
  const explicitConfig = productionServices(loadedConfig, args.prod, requested);
  selectServiceNames(explicitConfig, requested);

  // Stop and start under ONE lifecycle lock. Taking it twice (once per half)
  // would leave a window in which another `portler up` sees the services as
  // stopped and starts them itself, and this restart then starts them again.
  // restart always detaches, so the lock is released as soon as startup is done.
  return withLifecycleLock(loadedConfig.projectDir, async () => {
    // What this restart touches: the recorded entries it stops and the running
    // dependencies it leaves alone. pids.json says how each was started, and the
    // launch is decided from that, and from the flags, before anything is stopped.
    const before = await readPids(loadedConfig.projectDir);
    const running = before?.services ?? {};
    const runningNow = new Set(runningServices(before));
    const planFor = (config: PortlerConfig) => {
      const requestedRootNames = selectServiceNames(config, requested);
      // A restart without names stops every recorded service, including ones no longer in
      // the config; they are part of the running stack and count. The proxy's entry is
      // Portler's own and carries no mode.
      const stopping = requested.length > 0 ? requestedRootNames : Object.keys(running).filter((name) => name !== PROXY_SERVICE_NAME);
      const involved = [...new Set([...expandAndOrderServices(config, requestedRootNames), ...stopping])].filter(
        (name) => Object.hasOwn(running, name),
      );
      const stoppingSet = new Set(stopping);
      const starting = expandAndOrderServices(config, requestedRootNames).filter(
        (serviceName) => !runningNow.has(serviceName) || stoppingSet.has(serviceName),
      );
      const launch = planRestart({
        rawConfig: config,
        running,
        runningNow,
        stopping,
        involved,
        starting,
        requestedMode: mode,
        modeExplicit: args.positionals.length > requested.length,
        prod: args.prod,
        setup: args.setup,
        images: args.images,
      });
      return { requestedRootNames, starting, launch };
    };
    let rawConfig = explicitConfig;
    let plan = planFor(rawConfig);
    if (plan.launch.prod && !args.prod) {
      // A replayed --prod narrows to prod.services exactly as a typed one does, and the
      // plan is made again on what is left.
      rawConfig = productionServices(loadedConfig, true, requested);
      plan = planFor(rawConfig);
    }
    const { requestedRootNames, starting, launch } = plan;
    if (launch.replayed.length > 0) {
      process.stdout.write(`[portler] restart keeps the recorded launch: ${launch.replayed.join(', ')}\n`);
    }
    for (const name of launch.droppedPins) {
      process.stdout.write(`[portler] ${name}: the recorded image pin does not apply in this run mode and is dropped\n`);
    }

    // Check --image before anything is stopped. applyImageOverrides rejects an unknown
    // service or one that does not run in Docker in this mode, and a target this restart
    // leaves running would keep its old image. Either failure after the stop would leave
    // the requested services down with nothing restarted.
    if (Object.keys(launch.images).length > 0) {
      applyImageOverrides(configForRunMode(rawConfig, launch.mode), launch.images);
      validateImageOverrideTargets(launch.images, starting, runningNow);
    }

    // prod.require too: a deployment value that has gone missing is reported while the
    // services are still up, not after they were stopped and could not start again.
    if (launch.prod) {
      const runConfig = applyProduction(configForRunMode(rawConfig, launch.mode), true);
      assertProductionRequirements(runConfig, starting, await loadBaseEnv(runConfig, { allowMissing: true }), {
        projectSetup: launch.setup !== false,
      });
    }

    // With no names, stop everything in pids.json (like `portler down`) so
    // services removed from the config do not linger; otherwise stop only the
    // requested roots.
    const result = await stopServices(rawConfig.projectDir, requested.length > 0 ? requestedRootNames : undefined);
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    }

    // A service that was not confirmed stopped is still running and still
    // holding its port — whether Portler refused to signal it (identity) or the
    // teardown failed outright. Starting a second copy on top of it would be
    // worse than refusing: the user is told to deal with it, exactly as `down`
    // does.
    if (result.unverified.length > 0 || result.failures.length > 0) {
      const stuck = [...result.unverified, ...result.failures];
      throw new Error(
        `restart could not stop: ${stuck.join('; ')} — those services are (or may still be) running, so restart will ` +
          'not start a second copy on top of them. Stop them yourself: check each pid with ' +
          '"ps -o pid,ppid,lstart,command -p <pid>" and, once you have confirmed it is your service, stop it ' +
          '("kill -TERM -<pid>" signals its whole process group), then re-run restart.',
      );
    }

    await startPhase(rawConfig, launch.mode, requestedRootNames, {
      detach: true,
      skipRunning: true,
      prod: launch.prod,
      ...(launch.setup !== undefined ? { setup: launch.setup } : {}),
      images: launch.images,
    });

    return 0;
  });
}
