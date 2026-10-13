import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { deleteK8sResources, detectCluster } from '../../k8s/index.ts';
import { releasePorts } from '../../ports/index.ts';
import type { RunMode } from '../../config/index.ts';
import { shellQuote } from '../../process/docker.ts';
import { liveServiceNames, readPids, stopServices } from '../../process/index.ts';
import type { StopResult } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { PidServiceInfo, PidsFile, PortlerConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { parseRunMode, servicesWithPorts } from '../services.ts';

/**
 * Like selectServiceNames, but also accepts "proxy" as a target when a proxy
 * block exists (the proxy is not a service, yet `portler down proxy` should
 * stop it).
 */
function selectDownTargets(config: PortlerConfig, requested: string[]): string[] {
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
 * The `up` that starts the stopped services again the way they were started: the mode,
 * `--prod`, `--no-setup` and image pins their PID entries recorded (Kubernetes mode when
 * this down deleted them from the cluster), and this invocation's `--file`. Undefined when
 * they were started in different ways, since no single `up` brings all of them back.
 */
export function upSuggestion(
  serviceNames: readonly string[],
  launches: ReadonlyArray<PidServiceInfo | undefined>,
  mode: RunMode,
  file: string | undefined,
): string | undefined {
  const modes = new Set<RunMode>();
  const prods = new Set<boolean>();
  const setups = new Set<boolean>();
  const images: string[] = [];
  serviceNames.forEach((serviceName, index) => {
    const launch = launches[index];
    modes.add(mode === 'k8s' ? 'k8s' : (launch?.runMode ?? mode));
    prods.add(launch?.prod === true);
    setups.add(launch?.setup !== false);
    if (launch?.image !== undefined) images.push(`${serviceName}=${launch.image}`);
  });
  if (modes.size !== 1 || prods.size !== 1 || setups.size !== 1) return undefined;

  const [runMode] = modes;
  const parts = ['portler', 'up'];
  if (runMode !== 'local') parts.push(runMode!);
  parts.push('-d', ...serviceNames.map(shellQuote));
  if (file) parts.push('--file', shellQuote(file));
  if (prods.has(true)) parts.push('--prod');
  if (setups.has(false)) parts.push('--no-setup');
  for (const image of images) parts.push('--image', shellQuote(image));
  return parts.join(' ');
}

/**
 * `down redis` stops only redis. Services that depend on it keep running and start failing
 * against it, so name them: the user can stop them too, or bring the dependency back.
 * A running service's dependencies are the ones it recorded when it started, because an
 * edited portler.yml says nothing about what is already running; entries that record none
 * (older ones, Kubernetes port-forwards) use the config.
 */
async function warnAboutDependents(
  config: PortlerConfig,
  stoppedNames: string[],
  before: PidsFile | null,
  mode: RunMode,
  file: string | undefined,
): Promise<void> {
  const stopped = new Set(stoppedNames);
  const pids = await readPids(config.projectDir);
  const dependents: string[] = [];
  for (const name of await liveServiceNames(config.projectDir, pids)) {
    if (stopped.has(name)) continue;
    const dependencies =
      pids?.services[name]?.dependsOn ?? config.services[name]?.dependsOn.map((dependency) => dependency.service) ?? [];
    const on = dependencies.filter((dependency) => stopped.has(dependency));
    if (on.length > 0) dependents.push(`${name} (on ${on.join(', ')})`);
  }
  if (dependents.length === 0) return;

  const back = stoppedNames.filter((name) => name !== PROXY_SERVICE_NAME);
  const them = back.length === 1 ? 'it' : 'them';
  const command = back.length > 0 ? upSuggestion(back, back.map((name) => before?.services[name]), mode, file) : undefined;
  const fix =
    back.length === 0
      ? 'Stop them too.'
      : command
        ? `Stop them too, or bring ${them} back with "${command}".`
        : `Stop them too, or start ${back.join(', ')} again the way ${them} ${back.length === 1 ? 'was' : 'were'} started.`;
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
    let deletedFromCluster = false;
    if (mode === 'k8s') {
      const cluster = await detectCluster();
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
    } else if (!incomplete && !deletedFromCluster) {
      process.stdout.write('[portler] no running services found\n');
    }
    // A Kubernetes service without a port has no port-forward for stopServices to stop, but
    // deleting it from the cluster takes it away from its dependents all the same.
    const takenAway = [
      ...new Set([...result.stopped, ...(deletedFromCluster && selectedNames ? selectedNames.filter((name) => name !== PROXY_SERVICE_NAME) : [])]),
    ];
    if (selectedNames && takenAway.length > 0) await warnAboutDependents(config, takenAway, before, mode, args.file);

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
