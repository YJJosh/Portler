import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { applyImageOverrides, configForRunMode, loadConfig, proxyServiceConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { buildGeneratedEnv, hostResolveOptions } from '../../env/index.ts';
import {
  applyManifestFiles,
  buildServiceImages,
  type ClusterInfo,
  deleteK8sResources,
  detectCluster,
  ensureNamespace,
  ensureNamespaceClaimable,
  getNamespacePhase,
  loadImageIntoCluster,
  k8sServiceNames,
  portForwardPidInfo,
  recordLaunchContext,
  renderManifests,
  spawnPortForward,
  waitForNamespaceDeleted,
  waitForRollout,
  waitForStablePods,
  writeManifestFiles,
} from '../../k8s/index.ts';
import { runCommand, type CommandRunner } from '../../util/exec.ts';
import { allocateAssignments, releasePorts } from '../../ports/index.ts';
import { serviceTransport } from '../../ports/transport.ts';
import { readPids, liveServiceNames, stopServices, updatePids, waitForForegroundServices } from '../../process/index.ts';
import { proxyPidInfoFor, spawnProxy } from '../../proxy/index.ts';
import { isTcpReady, waitForServiceReady } from '../../readiness/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../../state/lock.ts';
import type { Assignments, PortlerConfig, ServiceAssignment } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printPortTable } from '../table.ts';
import { dependencyLevels, ensureNoOverlap, expandAndOrderServices, reportImageOverrides, selectServiceNames, servicesWithPorts, validateImageOverrideTargets } from '../services.ts';
import { applyShare, chooseShare } from '../../share/settings.ts';
import { reportShare } from '../../share/report.ts';
import { waitForSharedPort } from '../../share/ready.ts';
import { shareForwardSpec } from '../../share/command.ts';
import { buildProxyServerOptions } from '../../proxy/spawn.ts';
import { IncompleteTeardownError, listenForStartupCancellation, reportIncompleteTeardown, shareDefault, shareRequest } from './up.ts';

// How long a namespace left Terminating by an earlier `down` may take to clear.
const NAMESPACE_TERMINATION_TIMEOUT_MS = 120_000;
// Final pre-ready sweep: every forwarded port must accept a TCP connection.
const FORWARD_VERIFY_TIMEOUT_MS = 10_000;

export function validateK8sMode(config: PortlerConfig, selectedNames: string[]): void {
  // The whole project's name mapping, not only the selection: `up k8s foo_bar` then
  // `up k8s foo-bar` would apply over the same Deployment/Service.
  k8sServiceNames(Object.keys(config.services));

  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (!service.docker) {
      throw new Error(
        `service "${serviceName}" has no container config for Kubernetes. Add image, build, dockerfile, or docker: {...}`,
      );
    }
  }
}

/** `kubectl port-forward` carries TCP only, so `up k8s` refuses a UDP-only service (`k8s render`
 * still renders it) and forwards only the TCP half of a tcp+udp one. */
export function validateK8sForwards(config: PortlerConfig, selectedNames: string[]): void {
  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    if (service.port === undefined) continue;
    const transport = serviceTransport(service);
    if (transport === 'udp') {
      throw new Error(
        `service "${serviceName}" uses UDP, and "portler up k8s" reaches services through kubectl port-forward, which only carries TCP. ` +
          'Run it with "portler up docker", or expose it from the cluster yourself (render it with "portler k8s render").',
      );
    }
    if (transport === 'tcp+udp') {
      process.stderr.write(
        `[portler] warning: service "${serviceName}" uses TCP and UDP; kubectl port-forward only forwards its TCP port to this machine.\n`,
      );
    }
  }
}

/** For the local side of `up k8s`: kubectl port-forward binds only TCP here, so a tcp+udp service
 * needs only a free TCP port. Manifests keep the service's own transport. */
export function k8sForwardConfig(config: PortlerConfig): PortlerConfig {
  if (!Object.values(config.services).some((service) => serviceTransport(service) === 'tcp+udp')) return config;
  const services = Object.fromEntries(
    Object.entries(config.services).map(([name, service]) => [
      name,
      serviceTransport(service) === 'tcp+udp' ? { ...service, transport: 'tcp' as const } : service,
    ]),
  );
  return { ...config, services };
}

async function writePortForwardPid(
  config: PortlerConfig,
  serviceName: string,
  child: ChildProcess,
  assignment: ServiceAssignment,
  image: string | undefined,
): Promise<void> {
  const info = await portForwardPidInfo(config, config.services[serviceName]!, child, assignment, image);

  await updatePids(config.projectDir, (pids) => {
    pids.services[serviceName] = info;
  });
}

// A `down k8s --volumes` can leave the namespace Terminating, and applying into it fails
// ("namespace is being terminated").
async function waitOutTerminatingNamespace(cluster: ClusterInfo, config: PortlerConfig, signal?: AbortSignal): Promise<void> {
  if ((await getNamespacePhase(cluster, config.k8sNamespace, undefined, signal)) !== 'Terminating') return;

  process.stdout.write(
    `[portler] namespace ${config.k8sNamespace} is still terminating from a previous down; waiting for it to finish...\n`,
  );
  if (!(await waitForNamespaceDeleted(cluster, config.k8sNamespace, NAMESPACE_TERMINATION_TIMEOUT_MS, undefined, signal))) {
    throw new Error(
      `namespace ${config.k8sNamespace} did not finish terminating within ${NAMESPACE_TERMINATION_TIMEOUT_MS / 1_000}s; ` +
        'check for stuck finalizers ("kubectl get namespace") and retry',
    );
  }
}

// A late pod restart can kill a forward after its readiness check passed.
async function verifyForwards(
  config: PortlerConfig,
  children: Map<string, ChildProcess>,
  assignments: Assignments,
  signal?: AbortSignal,
): Promise<void> {
  for (const [serviceName, child] of children) {
    const assignment = assignments[serviceName];
    if (!assignment) continue;

    const deadline = Date.now() + FORWARD_VERIFY_TIMEOUT_MS;
    let connected = false;

    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`port-forward for service "${serviceName}" exited; ${assignment.url} is not reachable`);
      }
      if (await isTcpReady(assignment.host, assignment.port, 1_000, 0, signal)) {
        connected = true;
        break;
      }
      await delay(500, undefined, { signal });
    }

    if (!connected) {
      throw new Error(
        `port-forward for service "${serviceName}" is not accepting connections on ${assignment.host}:${assignment.port}`,
      );
    }
  }

  if (children.size > 0) {
    process.stdout.write(`[portler] verified ${children.size} port-forward(s): all localhost ports accepting connections\n`);
  }
}

interface K8sStack {
  children: Map<string, ChildProcess>;
  /** UNLOCKED, like the local one (see StartedStack in up.ts): the caller owns the locking. */
  teardown: () => Promise<void>;
}

// Runs under the lifecycle lock. An aborted `signal` ends startup like a failure: the rollback stops
// this run's port-forwards, deletes what it applied and releases its ports before the error returns.
async function startK8sPhase(
  args: ParsedArgs,
  launchedConfig: PortlerConfig,
  cluster: ClusterInfo,
  selectedNames: string[],
  signal?: AbortSignal,
): Promise<K8sStack> {
  signal?.throwIfAborted();
  const pids = await readPids(launchedConfig.projectDir);
  // The overlap check can run docker inspect for an earlier launch, so it is cancellable too.
  const run: CommandRunner = (command, args, input) => runCommand(command, args, input, signal);
  const runningNames = new Set(await liveServiceNames(launchedConfig.projectDir, pids, undefined, run));
  const liveEntries = [...runningNames].flatMap((name) => pids?.services[name] ?? []);
  const request = shareRequest(args) ?? (liveEntries.length === 0 ? shareDefault(args) : undefined);
  const config = applyShare(launchedConfig, await chooseShare(liveEntries, request));
  ensureNoOverlap(runningNames, selectedNames);
  // Read the cached state before writing the record, so a corrupt cache leaves none behind.
  const state = await readState(config.projectDir);
  // Before anything touches the cluster: `env` and `down k8s` find it through this record.
  // Only a complete teardown takes it back, since a rollback can fail to delete what it
  // applied. Its kubectl reads are cancellable; the rollback's are not, since it must finish.
  const forgetOwnRecord = await recordLaunchContext(config, cluster, run);

  const reserveNames = servicesWithPorts(config, selectedNames);
  const startProxy = config.proxy !== undefined && !runningNames.has(PROXY_SERVICE_NAME);
  if (startProxy) reserveNames.push(PROXY_SERVICE_NAME);
  // Ctrl-C may end the wait for another project's hold on the port registry.
  const assignments = await allocateAssignments(k8sForwardConfig(config), state, reserveNames, runningNames, {
    recorded: pids?.services,
    signal,
  }).catch(
    async (error: unknown) => {
      // Nothing is reserved or applied yet.
      await forgetOwnRecord();
      throw error;
    },
  );
  const generatedEnv = buildGeneratedEnv(assignments);

  const children = new Map<string, ChildProcess>();
  // Teardown deletes exactly these by label, even when every service was selected: the
  // config may have grown since, and a newer run may own the added services.
  const appliedNames: string[] = [];
  // Rollback never deletes volumes: a PVC with a database's data must survive a startup crash-loop. A
  // failed delete must not abort it: ports still need releasing, and a throw would hide the startup error.
  const stopNames = startProxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames;
  const teardown = async (): Promise<void> => {
    const result = await stopServices(config.projectDir, stopNames);
    const incomplete = reportIncompleteTeardown(result);
    let resourceCleanupError: Error | undefined;

    if (appliedNames.length > 0) {
      try {
        await deleteK8sResources(cluster, config, { serviceNames: appliedNames });
      } catch (error) {
        resourceCleanupError = error as Error;
        process.stderr.write(`[portler] warning: could not clean up Kubernetes resources: ${resourceCleanupError.message}\n`);
      }
    }

    // Keep reservations of forwards that survived, and all of them when the Kubernetes
    // delete failed: a later `down k8s` needs the bookkeeping intact.
    if (!resourceCleanupError) {
      const remaining = new Set(result.remaining);
      await releasePorts(
        config.projectDir,
        reserveNames.filter((serviceName) => !remaining.has(serviceName)),
      );
    }

    // A port-forward supervisor we could not stop is still forwarding into the
    // cluster; exiting 0 would report a teardown that did not happen.
    if (incomplete) throw new IncompleteTeardownError(result);
    if (resourceCleanupError) {
      throw new Error(`did not finish deleting this run's Kubernetes resources: ${resourceCleanupError.message}`);
    }
    await forgetOwnRecord();
  };

  try {
    // Inside the rollback, so a failed write releases the ports and the launch record.
    await writeState(config.projectDir, assignments);
    await writeRuntimeEnv(config.projectDir, generatedEnv);
    printPortTable(assignments, config.proxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames);
    reportShare(config, startProxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames, assignments);

    signal?.throwIfAborted();
    // Rendering checks required env, so it comes before any build or cluster change.
    const rendered = await renderManifests(config, selectedNames, assignments);
    const builtImages = await buildServiceImages(config, selectedNames, assignments, signal);

    for (const image of builtImages) {
      await loadImageIntoCluster(cluster, image, signal);
    }

    const manifestDir = await writeManifestFiles(config.projectDir, rendered);

    await waitOutTerminatingNamespace(cluster, config, signal);
    signal?.throwIfAborted();

    // `kubectl create`, never apply: apply would adopt a namespace that appeared since the ownership
    // check and label it ours, so `down k8s --volumes` deletes it; ensureNamespace refuses one not ours.
    // 00-namespace.yml stays on disk for `k8s render` but is not in the apply set.
    await ensureNamespace(cluster, config, run);

    // One dependency level at a time, as locally: a service is applied once its dependencies' pods are
    // stable and answer through their forward, so an api does not crash-loop on a starting postgres.
    for (const level of dependencyLevels(config, selectedNames)) {
      signal?.throwIfAborted();
      // Recorded before the apply: a failed apply may still have created some.
      appliedNames.push(...level);
      await applyManifestFiles(
        cluster,
        level.map((serviceName) => path.join(manifestDir, `${rendered.names.get(serviceName)!}.yml`)),
        signal,
      );

      await Promise.all(
        level.map(async (serviceName) => {
          const name = rendered.names.get(serviceName)!;
          await waitForRollout(cluster, config, serviceName, name, signal);
          await waitForStablePods(cluster, config, serviceName, name, signal);
        }),
      );
      signal?.throwIfAborted();

      // Probes start only once every forward has a pid entry: an abort during a sibling's write would
      // reject a probe nothing awaits yet, and Node exits on the unhandled rejection, skipping rollback.
      const readinessWaits: Array<() => Promise<void>> = [];

      // Not cancellable between a spawn and its pid entry: the entry is how the
      // rollback finds the port-forward to stop.
      for (const serviceName of level) {
        const service = config.services[serviceName]!;
        const assignment = assignments[serviceName];
        if (!assignment || service.port === undefined) continue;

        let forwardExited = false;
        const child = spawnPortForward(cluster, config, service, rendered.names.get(serviceName)!, assignment, !args.detach);
        child.once('exit', () => {
          forwardExited = true;
        });
        children.set(serviceName, child);
        if (args.detach) child.unref();

        await writePortForwardPid(config, serviceName, child, assignment, args.images?.[serviceName]);
        // applyK8sMode strips command healthchecks, so the readiness env is unused. An HTTP
        // healthcheck URL can use `${env.KEY}`, so resolve it with the env the pod got.
        const resolveOptions = hostResolveOptions(config, service, rendered.baseEnv, generatedEnv, assignments);
        readinessWaits.push(async () => {
          await waitForServiceReady(config, service, {}, assignments, assignment, () => forwardExited, 0, undefined, signal, resolveOptions);
          if (config.share && shareForwardSpec(config, service, assignment)) await waitForSharedPort(config.share, assignment, signal);
        });
      }

      const waits = readinessWaits.map((wait) => wait());
      for (const wait of waits) wait.catch(() => {});
      await Promise.all(waits);
      signal?.throwIfAborted();
    }

    // Forwards of early levels may have died while later levels rolled out.
    await verifyForwards(config, children, assignments, signal);
    signal?.throwIfAborted();

    // The proxy stays a host process routing to the port-forwards, so the project URL and
    // PORTLER_PROXY_* work as in the other run modes.
    if (config.proxy && startProxy) {
      let proxyExited = false;
      const child = spawnProxy(config.proxy, assignments, !args.detach, config.share);
      child.once('exit', () => {
        proxyExited = true;
      });
      children.set(PROXY_SERVICE_NAME, child);
      if (args.detach) child.unref();

      const info = await proxyPidInfoFor(config, child, assignments[PROXY_SERVICE_NAME]!);
      await updatePids(config.projectDir, (pids) => {
        pids.services[PROXY_SERVICE_NAME] = info;
      });
      await waitForServiceReady(
        config,
        proxyServiceConfig(config, config.proxy),
        {},
        assignments,
        assignments[PROXY_SERVICE_NAME],
        () => proxyExited,
        0,
        undefined,
        signal,
      );
      if (config.share && buildProxyServerOptions(config.proxy, assignments, config.share).shareAddresses) {
        await waitForSharedPort(config.share, assignments[PROXY_SERVICE_NAME]!, signal);
      }
      signal?.throwIfAborted();
    }
    if (config.proxy) process.stdout.write(`[portler] project url: ${assignments[PROXY_SERVICE_NAME]!.url}\n`);
  } catch (error) {
    // As in local mode: the rollback reports its own problems, and must not
    // replace the startup error with a cleanup one.
    try {
      await teardown();
    } catch (teardownError) {
      process.stderr.write(`[portler] warning: rollback was incomplete: ${(teardownError as Error).message}\n`);
    }
    throw error;
  }

  return { children, teardown };
}

export async function commandUpK8s(args: ParsedArgs, requested: string[]): Promise<number> {
  const rawConfig = await loadConfig(process.cwd(), args.file);
  const requestedRootNames = selectServiceNames(rawConfig, requested);
  const selectedNames = expandAndOrderServices(rawConfig, requestedRootNames);
  const modeConfig = configForRunMode(rawConfig, 'k8s');
  const config = applyImageOverrides(modeConfig, args.images ?? {});
  validateImageOverrideTargets(args.images ?? {}, selectedNames, new Set<string>());
  reportImageOverrides(modeConfig, args.images ?? {});

  validateK8sMode(config, selectedNames);
  validateK8sForwards(config, selectedNames);

  // As in local mode (startServices in up.ts): a foreground run that gets Ctrl-C or
  // SIGTERM during startup rolls back what it started and exits 130 or 143.
  const cancellation = listenForStartupCancellation(args.detach);
  const { signal } = cancellation;
  try {
    // Resolve the cluster and check namespace ownership (read-only) before anything is
    // reserved or spawned; the context is then pinned on every kubectl call. Cancellable,
    // so a hung API server or credential helper cannot swallow Ctrl-C.
    const run: CommandRunner = (command, args, input) => runCommand(command, args, input, signal);
    const cluster = await detectCluster(run);
    process.stdout.write(`[portler] kubectl context: ${cluster.context} (${cluster.type})\n`);
    await ensureNamespaceClaimable(cluster, config, run);

    // The lock covers decisions, not the foreground wait; the teardown that ends the wait retakes it.
    // The failure path inside uses the raw teardown, so nothing nests. The signal also ends a lock wait.
    const stack = await withLifecycleLock(config.projectDir, async () => {
      const stack = await startK8sPhase(args, config, cluster, selectedNames, signal);
      // A signal that arrived after the last startup check still rolls back under this lock.
      if (signal?.aborted) {
        await stack.teardown();
        signal.throwIfAborted();
      }
      return stack;
    }, { signal });

    if (args.detach) {
      process.stdout.write('[portler] services running in Kubernetes; port-forwards started in background\n');
      return 0;
    }
    if (signal?.aborted) {
      await withLifecycleLockForTeardown(config.projectDir, stack.teardown);
      return cancellation.exitCode()!;
    }

    // No await between removing our handlers and the supervisor installing its own.
    cancellation.unlisten();
    return waitForForegroundServices(stack.children, () => withLifecycleLockForTeardown(config.projectDir, stack.teardown));
  } catch (error) {
    const exitCode = cancellation.exitCode();
    if (exitCode !== undefined) return exitCode;
    throw error;
  } finally {
    cancellation.unlisten();
  }
}
