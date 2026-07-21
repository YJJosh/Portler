import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { configForRunMode, loadConfig, proxyServiceConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { buildGeneratedEnv } from '../../env/index.ts';
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
  renderManifests,
  spawnPortForward,
  waitForNamespaceDeleted,
  waitForRollout,
  waitForStablePods,
  writeManifestFiles,
} from '../../k8s/index.ts';
import { allocateAssignments, releasePorts } from '../../ports/index.ts';
import { readPids, runningServices, stopServices, updatePids, waitForForegroundServices } from '../../process/index.ts';
import { proxyPidInfoFor, spawnProxy } from '../../proxy/index.ts';
import { isTcpReady, waitForServiceReady } from '../../readiness/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock, withLifecycleLockForTeardown } from '../../state/lock.ts';
import { sleep } from '../../util/sleep.ts';
import type { Assignments, PortlerConfig, ServiceAssignment } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printPortTable } from '../table.ts';
import { dependencyLevels, ensureNoOverlap, expandAndOrderServices, selectServiceNames, servicesWithPorts } from '../services.ts';
import { IncompleteTeardownError, reportIncompleteTeardown } from './up.ts';

/** How long a namespace left Terminating by a previous down may take to clear. */
const NAMESPACE_TERMINATION_TIMEOUT_MS = 120_000;
/** Final pre-ready sweep: every forwarded port must accept a TCP connection. */
const FORWARD_VERIFY_TIMEOUT_MS = 10_000;

export function validateK8sMode(config: PortlerConfig, selectedNames: string[]): void {
  // Validate the whole project's name mapping, not only this invocation's
  // selection. Otherwise `up k8s foo_bar` followed by `up k8s foo-bar` applies
  // over the same Deployment/Service even though each one-service render looks
  // collision-free in isolation.
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

/** Record one freshly spawned port-forward, merging with the existing file (see up.ts). */
async function writePortForwardPid(
  config: PortlerConfig,
  serviceName: string,
  child: ChildProcess,
  assignment: ServiceAssignment,
): Promise<void> {
  const info = await portForwardPidInfo(config, config.services[serviceName]!, child, assignment);

  await updatePids(config.projectDir, (pids) => {
    pids.services[serviceName] = info;
  });
}

/**
 * A previous `down k8s --volumes` may have left the namespace Terminating;
 * applying into it fails with "namespace is being terminated", so wait it out
 * (bounded).
 */
async function waitOutTerminatingNamespace(cluster: ClusterInfo, config: PortlerConfig): Promise<void> {
  if ((await getNamespacePhase(cluster, config.k8sNamespace)) !== 'Terminating') return;

  process.stdout.write(
    `[portler] namespace ${config.k8sNamespace} is still terminating from a previous down; waiting for it to finish...\n`,
  );
  if (!(await waitForNamespaceDeleted(cluster, config.k8sNamespace, NAMESPACE_TERMINATION_TIMEOUT_MS))) {
    throw new Error(
      `namespace ${config.k8sNamespace} did not finish terminating within ${NAMESPACE_TERMINATION_TIMEOUT_MS / 1_000}s; ` +
        'check for stuck finalizers ("kubectl get namespace") and retry',
    );
  }
}

/**
 * Final gate before declaring the stack up: every port-forward supervisor must
 * still be alive and its localhost port must actually accept a TCP connection
 * right now. Catches forwards killed by late pod restarts after their initial
 * readiness check passed.
 */
async function verifyForwards(
  config: PortlerConfig,
  children: Map<string, ChildProcess>,
  assignments: Assignments,
): Promise<void> {
  for (const [serviceName, child] of children) {
    const assignment = assignments[serviceName];
    if (!assignment) continue;

    const deadline = Date.now() + FORWARD_VERIFY_TIMEOUT_MS;
    let connected = false;

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`port-forward for service "${serviceName}" exited; ${assignment.url} is not reachable`);
      }
      if (await isTcpReady(assignment.host, assignment.port)) {
        connected = true;
        break;
      }
      await sleep(500);
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

/** The start decision for k8s mode. Runs under the lifecycle lock (see up.ts). */
async function startK8sPhase(
  args: ParsedArgs,
  config: PortlerConfig,
  cluster: ClusterInfo,
  selectedNames: string[],
): Promise<K8sStack> {
  const runningNames = new Set(runningServices(await readPids(config.projectDir)));
  ensureNoOverlap(runningNames, selectedNames);

  const state = await readState(config.projectDir);
  const reserveNames = servicesWithPorts(config, selectedNames);
  const startProxy = config.proxy !== undefined && !runningNames.has(PROXY_SERVICE_NAME);
  if (startProxy) reserveNames.push(PROXY_SERVICE_NAME);
  const assignments = await allocateAssignments(config, state, reserveNames, runningNames);
  const generatedEnv = buildGeneratedEnv(assignments);

  await writeState(config.projectDir, assignments);
  await writeRuntimeEnv(config.projectDir, generatedEnv);

  printPortTable(assignments, config.proxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames);

  const isFullSelection = selectedNames.length === Object.keys(config.services).length;
  const children = new Map<string, ChildProcess>();
  let applied = false;
  // stopServices kills the port-forward supervisors and prunes their pids.json
  // entries; the Kubernetes resources themselves go with the namespace (full)
  // or by label (partial). Nothing to delete when the failure came before apply.
  // Rolling back a failed start never deletes volumes: a PVC that already holds
  // a database's data must survive a crash-loop during startup.
  //
  // A failure while deleting must not abort the rollback — the ports still have
  // to be released, and on the error path a throw here would replace the real
  // startup error with a misleading cleanup one.
  const stopNames = startProxy ? [...selectedNames, PROXY_SERVICE_NAME] : selectedNames;
  const teardown = async (): Promise<void> => {
    const result = await stopServices(config.projectDir, stopNames);
    const incomplete = reportIncompleteTeardown(result);
    let resourceCleanupError: Error | undefined;

    if (applied) {
      try {
        await deleteK8sResources(cluster, config, { serviceNames: isFullSelection ? undefined : selectedNames });
      } catch (error) {
        resourceCleanupError = error as Error;
        process.stderr.write(`[portler] warning: could not clean up Kubernetes resources: ${resourceCleanupError.message}\n`);
      }
    }

    // Do not return reservations for forwards that survived. If Kubernetes
    // deletion failed, keep all of them: the lifecycle is incomplete and a
    // later explicit `down k8s` needs the bookkeeping intact.
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
  };

  try {
    const builtImages = await buildServiceImages(config, selectedNames, assignments);

    for (const image of builtImages) {
      await loadImageIntoCluster(cluster, image);
    }

    const rendered = await renderManifests(config, selectedNames, assignments);
    const manifestDir = await writeManifestFiles(config.projectDir, rendered);

    await waitOutTerminatingNamespace(cluster, config);

    // The namespace is CREATED here (kubectl create), never applied. The
    // rendered 00-namespace.yml stays on disk for `portler k8s render` and for
    // the user to read, but it is deliberately not in the apply set below:
    // `kubectl apply` on a namespace that appeared between the ownership check
    // and this line would ADOPT it — stamping Portler's labels onto a stranger's
    // namespace and thereby authorizing a later `down k8s --volumes` to delete
    // it. `create` fails on AlreadyExists instead, and ensureNamespace re-reads
    // the namespace and refuses unless it really is ours.
    applied = true;
    await ensureNamespace(cluster, config);

    // Apply and await one dependency level at a time — a service's manifests
    // are not applied until every dependency's pods are stable and answering
    // through their port-forward, mirroring local/Docker startup ordering. This
    // avoids crash-loops like an api migrating against a postgres that is
    // still initializing (and the dead port-forwards those restarts leave).
    for (const level of dependencyLevels(config, selectedNames)) {
      await applyManifestFiles(cluster, level.map((serviceName) => path.join(manifestDir, `${rendered.names.get(serviceName)!}.yml`)));

      await Promise.all(
        level.map(async (serviceName) => {
          const name = rendered.names.get(serviceName)!;
          await waitForRollout(cluster, config, serviceName, name);
          await waitForStablePods(cluster, config, serviceName, name);
        }),
      );

      const readinessWaits: Array<Promise<void>> = [];

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

        await writePortForwardPid(config, serviceName, child, assignment);
        // k8s mode never has command healthchecks (applyK8sMode strips them),
        // so the readiness env is not consulted.
        readinessWaits.push(waitForServiceReady(config, service, {}, assignments, assignment, () => forwardExited));
      }

      for (const wait of readinessWaits) wait.catch(() => {});
      await Promise.all(readinessWaits);
    }

    // Forwards started for early levels may have died while later levels were
    // rolling out; never report ready with a dead forward.
    await verifyForwards(config, children, assignments);

    // The built-in proxy remains a host process in Kubernetes mode and routes to
    // the localhost port-forwards. This keeps the documented one-project URL and
    // PORTLER_PROXY_* contract consistent across all three run modes.
    if (config.proxy && startProxy) {
      let proxyExited = false;
      const child = spawnProxy(config.proxy, assignments, !args.detach);
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
      );
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
  const config = configForRunMode(rawConfig, 'k8s');

  validateK8sMode(config, selectedNames);

  // Resolve (and validate) the cluster before anything is allocated or spawned:
  // an unrecognized context must abort here, not after ports are reserved. The
  // resolved context is then pinned onto every kubectl call below. The namespace
  // ownership check is read-only and also runs before anything is reserved; the
  // namespace itself is created (never applied) inside the start phase.
  const cluster = await detectCluster();
  process.stdout.write(`[portler] kubectl context: ${cluster.context} (${cluster.type})\n`);
  await ensureNamespaceClaimable(cluster, config);

  // As in local mode: the lifecycle lock covers the decision, never the
  // foreground wait — but the teardown that ends that wait is a decision again
  // (it stops the forwards, deletes cluster resources and releases the ports),
  // so it takes the lock back. startK8sPhase's own failure path already runs
  // under the lock and uses the raw teardown, so nothing nests.
  const stack = await withLifecycleLock(config.projectDir, () => startK8sPhase(args, config, cluster, selectedNames));

  if (args.detach) {
    process.stdout.write('[portler] services running in Kubernetes; port-forwards started in background\n');
    return 0;
  }

  return waitForForegroundServices(stack.children, () => withLifecycleLockForTeardown(config.projectDir, stack.teardown));
}
