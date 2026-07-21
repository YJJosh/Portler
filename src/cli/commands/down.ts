import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { deleteK8sResources, detectCluster } from '../../k8s/index.ts';
import { releasePorts } from '../../ports/index.ts';
import { stopServices } from '../../process/index.ts';
import type { StopResult } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { PortlerConfig } from '../../types/index.ts';
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
    const result = await stopServices(config.projectDir, selectedNames, { force: args.force });

    // Deleting cluster resources DOES touch a cluster, so it is gated on the
    // context being a recognized local one, and every kubectl call is pinned
    // to it. PVCs (and the namespace) survive unless --volumes was passed, so
    // a database's data outlives an ordinary down/up cycle. If this fails, keep
    // every reservation: releasing ports while the requested teardown is only
    // half complete is the false all-clear the registry is meant to prevent.
    if (mode === 'k8s') {
      const cluster = await detectCluster();
      await deleteK8sResources(cluster, config, {
        serviceNames: selectedNames,
        deleteVolumes: args.volumes,
        awaitNamespace: true,
      });
    }

    await releasePorts(config.projectDir, releasableTargets(config, selectedNames, result));

    const incomplete = result.unverified.length > 0 || result.failures.length > 0;
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    } else if (!incomplete) {
      process.stdout.write('[portler] no running services found\n');
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
