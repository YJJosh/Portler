import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { formatYamlDocuments } from '../parse/yaml-format.ts';
import { prefixStream, readProcessStartToken } from '../process/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import type { ClusterInfo } from './cluster.ts';
import { captureOutput, runStreaming } from './exec.ts';
import type { ForwardSpec } from './forward-supervisor.ts';
import { k8sServiceNames, MANAGED_BY_LABEL, namespaceManifest, PROJECT_LABEL, projectLabels } from './manifests.ts';
import type { PidServiceInfo, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

const ROLLOUT_TIMEOUT = '180s';
/** Pods must stay ready with no new restarts for this long after rollout. */
const STABILITY_WINDOW_MS = 5_000;
const STABILITY_TIMEOUT_MS = 120_000;
const STABILITY_POLL_MS = 1_000;

/**
 * Pin `--context` on every kubectl call: with bare `kubectl`, a context switch after
 * the cluster was read would send Portler's applies and deletes to another cluster.
 */
function kubectlArgs(cluster: ClusterInfo, args: string[]): string[] {
  return ['--context', cluster.context, ...args];
}

/** Paths may be files or a directory. An aborted `signal` stops kubectl and rejects once it has exited. */
export async function applyManifestFiles(cluster: ClusterInfo, paths: string[], signal?: AbortSignal): Promise<void> {
  const args = ['apply'];
  for (const manifestPath of paths) args.push('-f', manifestPath);
  await runStreaming('kubectl', kubectlArgs(cluster, args), 'portler', undefined, signal);
}

/** Wait until the service's Deployment has rolled out (pods ready). */
export async function waitForRollout(
  cluster: ClusterInfo,
  config: PortlerConfig,
  serviceName: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await runStreaming(
      'kubectl',
      kubectlArgs(cluster, ['rollout', 'status', `deployment/${name}`, '--namespace', config.k8sNamespace, `--timeout=${ROLLOUT_TIMEOUT}`]),
      serviceName,
      undefined,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    // kubectl's "timed out waiting for the condition" does not say why, so name the pods'
    // waiting reasons (ImagePullBackOff, ...). A failed read keeps the original error.
    const problems = await podProblems(cluster, config.k8sNamespace, name).catch(() => []);
    if (problems.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const pullHint = problems.some((problem) => /ImagePull|ErrImageNeverPull|InvalidImageName/.test(problem))
      ? '\nThe cluster could not get the image. Portler only loads locally built images into kind, k3d, minikube and clusters that share the Docker daemon; other clusters must pull it from a registry.'
      : '';
    throw new Error(`${reason}\n${serviceName}'s pod did not start: ${problems.join('; ')}${pullHint}`, { cause: error });
  }
}

/** Waiting reasons of a Deployment's pods, e.g. `ImagePullBackOff: Back-off pulling image "x"`. */
async function podProblems(cluster: ClusterInfo, namespace: string, appName: string): Promise<string[]> {
  const raw = await captureOutput(
    'kubectl',
    kubectlArgs(cluster, ['get', 'pods', '--namespace', namespace, '--selector', `app=${appName}`, '-o', 'json']),
  );
  const parsed = JSON.parse(raw) as {
    items?: Array<{
      status?: {
        initContainerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>;
        containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }>;
      };
    }>;
  };
  const problems = new Set<string>();
  for (const pod of parsed.items ?? []) {
    const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
    for (const waiting of statuses.map((status) => status.state?.waiting)) {
      if (!waiting?.reason || waiting.reason === 'ContainerCreating' || waiting.reason === 'PodInitializing') continue;
      problems.add(waiting.message ? `${waiting.reason}: ${waiting.message.split('\n')[0]}` : waiting.reason);
    }
  }
  return [...problems];
}

interface PodSnapshot {
  podCount: number;
  allReady: boolean;
  restarts: number;
}

async function podSnapshot(cluster: ClusterInfo, namespace: string, appName: string, signal?: AbortSignal): Promise<PodSnapshot> {
  const raw = await captureOutput(
    'kubectl',
    kubectlArgs(cluster, ['get', 'pods', '--namespace', namespace, '--selector', `app=${appName}`, '-o', 'json']),
    signal,
  );
  const parsed = JSON.parse(raw) as {
    items?: Array<{
      status?: {
        phase?: string;
        conditions?: Array<{ type?: string; status?: string }>;
        containerStatuses?: Array<{ restartCount?: number }>;
      };
    }>;
  };

  const items = parsed.items ?? [];
  let restarts = 0;
  let allReady = items.length > 0;

  for (const pod of items) {
    const status = pod.status ?? {};
    const ready =
      status.phase === 'Running' &&
      (status.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    if (!ready) allReady = false;
    for (const container of status.containerStatuses ?? []) restarts += container.restartCount ?? 0;
  }

  return { podCount: items.length, allReady, restarts };
}

/**
 * `kubectl rollout status` returns once a pod is ready, which without a readiness probe
 * only means the process started; a pod that then crashes kills its port-forward. So the
 * pods must stay ready with no new restarts for STABILITY_WINDOW_MS.
 */
export async function waitForStablePods(
  cluster: ClusterInfo,
  config: PortlerConfig,
  serviceName: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + STABILITY_TIMEOUT_MS;
  let baseline = await podSnapshot(cluster, config.k8sNamespace, name, signal);
  let windowStart = Date.now();

  while (Date.now() < deadline) {
    await delay(STABILITY_POLL_MS, undefined, { signal });
    const snapshot = await podSnapshot(cluster, config.k8sNamespace, name, signal);

    if (!snapshot.allReady || snapshot.restarts !== baseline.restarts || snapshot.podCount !== baseline.podCount) {
      if (snapshot.restarts > baseline.restarts) {
        process.stdout.write(`[portler] ${serviceName}: pod restarted; waiting for it to stabilize...\n`);
      }
      baseline = snapshot;
      windowStart = Date.now();
      continue;
    }

    if (Date.now() - windowStart >= STABILITY_WINDOW_MS) return;
  }

  throw new Error(`pods for service "${serviceName}" kept restarting; check "kubectl logs -n ${config.k8sNamespace} -l app=${name}"`);
}

/**
 * Only 'absent' lets Portler create (and later delete) the namespace. An auth error or an
 * unreachable cluster is 'error', never 'absent', so it cannot claim a namespace it never saw.
 */
export type NamespaceRead =
  | { status: 'found'; labels: Record<string, string> }
  | { status: 'absent' }
  | { status: 'error'; message: string };

/**
 * True only for the API server's `Error from server (NotFound): namespaces "x" not found`.
 * Other kubectl "not found" errors (`kubectl: command not found`, a missing credential
 * plugin) are operational errors: read as 'absent', they would license creating and later
 * deleting the namespace. A NotFound about another kind does not count either.
 */
export function isNamespaceNotFound(stderr: string): boolean {
  const text = stderr.trim();
  if (text === '') return false;

  const mentionsNamespace = /\bnamespaces?\b/i.test(text);
  if (!mentionsNamespace) return false;

  // The API-server error, then the bare form some kubectl versions print.
  if (/error from server \(notfound\)/i.test(text)) return true;

  return /\bnamespaces?\s+"[^"]*"\s+not found\b/i.test(text);
}

export function namespaceReadArgs(cluster: ClusterInfo, namespace: string): string[] {
  // `-o json`, not `-o jsonpath={.metadata.labels}`: kubectl prints a jsonpath map in Go
  // syntax (`map[a:b]`), not JSON, so the labels would not parse.
  return kubectlArgs(cluster, ['get', 'namespace', namespace, '-o', 'json']);
}

export function parseNamespaceRead(code: number, stdout: string, stderr: string): NamespaceRead {
  if (code !== 0) {
    if (isNamespaceNotFound(stderr)) return { status: 'absent' };
    return { status: 'error', message: stderr.trim().split('\n')[0] || `kubectl get namespace exited ${code}` };
  }

  try {
    const parsed = JSON.parse(stdout) as { metadata?: { labels?: unknown } };
    const labels = parsed.metadata?.labels;
    if (labels === undefined || labels === null) return { status: 'found', labels: {} };
    if (typeof labels !== 'object' || Array.isArray(labels)) return { status: 'found', labels: {} };

    return { status: 'found', labels: labels as Record<string, string> };
  } catch {
    return { status: 'error', message: 'could not parse "kubectl get namespace -o json" output' };
  }
}

/** Read a namespace, keeping absent / found / error apart. */
export async function readNamespace(
  cluster: ClusterInfo,
  namespace: string,
  run: CommandRunner = runCommand,
): Promise<NamespaceRead> {
  const result = await run('kubectl', namespaceReadArgs(cluster, namespace));
  return parseNamespaceRead(result.code, result.stdout, result.stderr);
}

/** The namespace's status.phase ("Active", "Terminating"), or null when absent. Throws on an operational error. */
export async function getNamespacePhase(
  cluster: ClusterInfo,
  namespace: string,
  run: CommandRunner = runCommand,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await run('kubectl', kubectlArgs(cluster, ['get', 'namespace', namespace, '-o', 'jsonpath={.status.phase}']), undefined, signal);

  if (result.code !== 0) {
    if (isNamespaceNotFound(result.stderr)) return null;
    throw new Error(`could not read namespace ${namespace}: ${result.stderr.trim().split('\n')[0] || `exit ${result.code}`}`);
  }

  return result.stdout.trim() || null;
}

/**
 * True once a NotFound read confirms the namespace is gone within `timeoutMs`; an API error
 * counts as still there. An aborted `signal` ends the wait with its reason.
 */
export async function waitForNamespaceDeleted(
  cluster: ClusterInfo,
  namespace: string,
  timeoutMs: number,
  run: CommandRunner = runCommand,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    signal?.throwIfAborted();
    const gone = await getNamespacePhase(cluster, namespace, run, signal).then(
      (phase) => phase === null,
      () => false,
    );
    if (gone) return true;
    if (Date.now() >= deadline) return false;

    await delay(1_000, undefined, { signal });
  }
}

export type NamespaceOwnership =
  /** Labelled as this project's — Portler may apply into it and delete it. */
  | 'owned'
  /** Exists but belongs to someone else (or is unlabelled) — hands off. */
  | 'foreign'
  /** Does not exist — Portler will create it. */
  | 'absent';

/**
 * An existing namespace not labelled as this project's is 'foreign' even if the name matches:
 * it may be a shared one (or `default`), and deleting it would delete everyone's workloads.
 */
export function namespaceOwnership(labels: Record<string, string> | null, config: PortlerConfig): NamespaceOwnership {
  if (labels === null) return 'absent';

  const expected = projectLabels(config);
  const isOurs = labels[MANAGED_BY_LABEL] === expected[MANAGED_BY_LABEL] && labels[PROJECT_LABEL] === expected[PROJECT_LABEL];

  return isOurs ? 'owned' : 'foreign';
}

function foreignNamespaceError(namespace: string): Error {
  return new Error(
    `namespace "${namespace}" already exists but is not managed by this Portler project ` +
      `(it lacks ${MANAGED_BY_LABEL}=portler / ${PROJECT_LABEL} for this project). Portler will not apply into or ` +
      'delete a namespace it did not create — it could be a shared namespace. Set "k8s_namespace:" in portler.yml ' +
      'to a name Portler can own, or delete the existing namespace yourself.',
  );
}

function namespaceReadError(namespace: string, message: string): Error {
  return new Error(
    `could not determine whether namespace "${namespace}" belongs to this project: ${message}. ` +
      'Portler refuses to apply into (or delete) a namespace whose ownership it cannot read — the cluster may be ' +
      'unreachable, or this user may lack permission to get namespaces.',
  );
}

/**
 * Read-only ownership gate: throws on a foreign or unreadable namespace. Runs before any
 * port is reserved, so `up k8s` aborts early.
 */
export async function ensureNamespaceClaimable(
  cluster: ClusterInfo,
  config: PortlerConfig,
  run: CommandRunner = runCommand,
): Promise<NamespaceOwnership> {
  const read = await readNamespace(cluster, config.k8sNamespace, run);
  if (read.status === 'error') throw namespaceReadError(config.k8sNamespace, read.message);
  if (read.status === 'absent') return 'absent';

  const ownership = namespaceOwnership(read.labels, config);
  if (ownership === 'foreign') throw foreignNamespaceError(config.k8sNamespace);

  return ownership;
}

/** argv for creating the namespace from a manifest on stdin. */
export function namespaceCreateArgs(cluster: ClusterInfo): string[] {
  // `create`, never `apply`: `apply` would label a namespace someone created since the
  // check as ours, letting `down --volumes` delete it. `create` fails with AlreadyExists.
  return kubectlArgs(cluster, ['create', '-f', '-']);
}

/** kubectl's AlreadyExists wording for a create that lost a race. */
export function isAlreadyExistsError(stderr: string): boolean {
  return /alreadyexists|already exists/i.test(stderr);
}

/**
 * Create the project's namespace when absent, or throw unless it is ours. The only place a
 * namespace is created; it is never in the manifests `up k8s` applies. If someone creates it
 * between the check and `kubectl create`, the re-read after AlreadyExists must find it ours.
 */
export async function ensureNamespace(
  cluster: ClusterInfo,
  config: PortlerConfig,
  run: CommandRunner = runCommand,
): Promise<void> {
  const ownership = await ensureNamespaceClaimable(cluster, config, run);
  if (ownership === 'owned') return;

  const manifest = formatYamlDocuments([namespaceManifest(config)]);
  const created = await run('kubectl', namespaceCreateArgs(cluster), manifest);
  if (created.code === 0) return;

  if (!isAlreadyExistsError(created.stderr)) {
    throw new Error(
      `could not create namespace "${config.k8sNamespace}": ${created.stderr.trim().split('\n')[0] || `exit ${created.code}`}`,
    );
  }

  // Lost the create race: whoever won must still be us.
  const read = await readNamespace(cluster, config.k8sNamespace, run);
  if (read.status === 'error') throw namespaceReadError(config.k8sNamespace, read.message);
  if (read.status === 'absent') {
    throw new Error(
      `namespace "${config.k8sNamespace}" reported AlreadyExists but then could not be read; retry "portler up k8s"`,
    );
  }
  if (namespaceOwnership(read.labels, config) !== 'owned') throw foreignNamespaceError(config.k8sNamespace);
}

export interface DeleteK8sOptions {
  /** Only these services' resources; undefined means the whole project. */
  serviceNames?: string[];
  /**
   * Also delete PersistentVolumeClaims, and for a full teardown the whole namespace.
   * Off by default, so a database's data survives `portler down k8s`.
   */
  deleteVolumes?: boolean;
  /** Block (bounded) until a deleted namespace is fully gone. */
  awaitNamespace?: boolean;
}

/**
 * Label selector limiting a delete to this project's resources. A delete by service name
 * keeps the project label too: `app in (api)` alone would match another project's `api`.
 */
export function deleteSelector(config: PortlerConfig, serviceNames?: string[]): string {
  const ownership = `${MANAGED_BY_LABEL}=portler,${PROJECT_LABEL}=${projectLabels(config)[PROJECT_LABEL]}`;
  if (!serviceNames) return ownership;

  const names = [...k8sServiceNames(serviceNames).values()];
  return `${ownership},app in (${names.join(',')})`;
}

/** Resource kinds a delete targets, with PVCs included only on explicit request. */
export function deleteResourceKinds(deleteVolumes: boolean): string {
  return deleteVolumes ? 'deployment,service,persistentvolumeclaim' : 'deployment,service';
}

/** What deleteK8sResources found to delete. */
export interface K8sDeleteResult {
  /** Whether anything was deleted: the namespace, or at least one resource in it. */
  deleted: boolean;
  /** Of the services asked for by name, those whose Deployment was deleted: no longer running in the cluster. */
  services: string[];
}

/**
 * Delete the project's Deployments and Services by label, after checking namespace
 * ownership; a foreign namespace is never touched. The namespace and PVCs stay unless
 * `deleteVolumes`, which for a full teardown deletes the whole owned namespace.
 */
export async function deleteK8sResources(
  cluster: ClusterInfo,
  config: PortlerConfig,
  options: DeleteK8sOptions = {},
  run: CommandRunner = runCommand,
): Promise<K8sDeleteResult> {
  const { serviceNames, deleteVolumes = false, awaitNamespace = false } = options;
  const namespace = config.k8sNamespace;

  // An unreadable namespace is not absent: "nothing to delete" would let the caller
  // release the ports and forget the state while resources still run.
  const read = await readNamespace(cluster, namespace, run);
  if (read.status === 'error') throw namespaceReadError(namespace, read.message);
  if (read.status === 'absent') return { deleted: false, services: [] };

  const ownership = namespaceOwnership(read.labels, config);
  if (ownership === 'foreign') throw foreignNamespaceError(namespace);

  // Full teardown with volumes: deleting the namespace deletes everything in it.
  if (!serviceNames && deleteVolumes) {
    const deleted = await run(
      'kubectl',
      kubectlArgs(cluster, ['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']),
    );
    if (deleted.code !== 0) {
      throw new Error(
        `could not delete Kubernetes namespace ${namespace}: ${deleted.stderr.trim().split('\n')[0] || `exit ${deleted.code}`}`,
      );
    }

    process.stdout.write(`[portler] deleting Kubernetes namespace ${namespace} (including volumes)\n`);
    if (awaitNamespace && (await getNamespacePhase(cluster, namespace, run)) !== null) {
      process.stdout.write(`[portler] waiting for namespace ${namespace} to finish terminating (up to 60s)...\n`);
      if (!(await waitForNamespaceDeleted(cluster, namespace, 60_000, run))) {
        process.stderr.write(
          `[portler] note: namespace ${namespace} is still terminating; the next "portler up k8s" will wait for it\n`,
        );
      }
    }
    return { deleted: true, services: [] };
  }

  const deleted = await run(
    'kubectl',
    kubectlArgs(cluster, [
      'delete',
      deleteResourceKinds(deleteVolumes),
      '--namespace',
      namespace,
      '--selector',
      deleteSelector(config, serviceNames),
      '--ignore-not-found',
      '--wait=false',
      // One `kind/name` line per deleted resource: --ignore-not-found succeeds either way.
      '-o',
      'name',
    ]),
  );

  const what = serviceNames ? `for: ${serviceNames.join(', ')}` : `in namespace ${namespace}`;

  // Throw, so `down` does not release the ports while the Deployments still run.
  if (deleted.code !== 0) {
    throw new Error(
      `could not delete Kubernetes resources ${what}: ${deleted.stderr.trim().split('\n')[0] || `exit ${deleted.code}`}`,
    );
  }

  // When nothing matches, kubectl prints "No resources found" on stdout. A PVC is not
  // named after its service, so it names none.
  const removed = deleted.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/\S+$/.test(line));
  const byK8sName = new Map([...k8sServiceNames(serviceNames ?? []).entries()].map(([service, name]) => [name, service]));
  const owners = (kinds: (kind: string) => boolean) => [
    ...new Set(
      removed.flatMap((resource) => {
        const [kind = '', name = ''] = resource.split('/', 2);
        const service = kinds(kind) ? byK8sName.get(name) : undefined;
        return service !== undefined ? [service] : [];
      }),
    ),
  ];
  if (removed.length === 0) {
    process.stdout.write(`[portler] no Kubernetes resources found ${what}\n`);
    return { deleted: false, services: [] };
  }
  const touched = owners((kind) => kind.startsWith('deployment') || kind === 'service');
  process.stdout.write(`[portler] deleted Kubernetes resources ${touched.length > 0 ? `for: ${touched.join(', ')}` : what}\n`);
  if (!deleteVolumes) {
    process.stdout.write('[portler] kept PersistentVolumeClaims; pass --volumes to delete stored data too\n');
  }
  return { deleted: true, services: owners((kind) => kind.startsWith('deployment')) };
}

/**
 * Services with a Deployment in the namespace, tracked by a port-forward or not. Undefined
 * when kubectl could not say, or when two services share a Kubernetes name.
 */
export async function deployedK8sServices(
  cluster: ClusterInfo,
  config: PortlerConfig,
  run: CommandRunner = runCommand,
): Promise<string[] | undefined> {
  let byK8sName: Map<string, string>;
  try {
    byK8sName = new Map([...k8sServiceNames(Object.keys(config.services)).entries()].map(([service, name]) => [name, service]));
  } catch {
    return undefined;
  }
  const names = await projectDeploymentNames(cluster, config, run);
  return names?.flatMap((name) => {
    const service = byK8sName.get(name);
    return service !== undefined ? [service] : [];
  });
}

/**
 * Names of this project's Deployments in `namespace` (default: the configured one), by label,
 * so including services removed from portler.yml. Undefined when kubectl could not say.
 */
export async function projectDeploymentNames(
  cluster: ClusterInfo,
  config: PortlerConfig,
  run: CommandRunner = runCommand,
  namespace: string = config.k8sNamespace,
): Promise<string[] | undefined> {
  const listed = await run(
    'kubectl',
    kubectlArgs(cluster, ['get', 'deployment', '--namespace', namespace, '--selector', deleteSelector(config), '-o', 'name']),
  );
  if (listed.code !== 0) return undefined;
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[\w.-]+\/\S+$/.test(line))
    .map((resource) => resource.split('/', 2)[1]!);
}

/**
 * Start `portler __k8s-forward`, which reruns `kubectl port-forward` with capped backoff when
 * a pod restart kills it. It is the tracked pid and leads its own process group with kubectl
 * inside, so it survives `up k8s -d` and stopServices' group signal stops both.
 */
export function spawnPortForward(
  cluster: ClusterInfo,
  config: PortlerConfig,
  service: ServiceConfig,
  name: string,
  assignment: ServiceAssignment,
  attachLogs: boolean,
): ChildProcess {
  const spec: ForwardSpec = {
    serviceName: service.name,
    k8sName: name,
    namespace: config.k8sNamespace,
    localPort: assignment.port,
    targetPort: service.port!,
    address: assignment.host,
    context: cluster.context,
  };

  // Re-exec the running entrypoint (.ts or .js) with the same node flags.
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, '__k8s-forward', JSON.stringify(spec)], {
    cwd: config.projectDir,
    detached: true,
    stdio: attachLogs ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
  });

  if (attachLogs) {
    if (child.stdout) prefixStream(service.name, child.stdout, process.stdout);
    if (child.stderr) prefixStream(service.name, child.stderr, process.stderr);
  }

  child.on('error', (error) => {
    process.stderr.write(`[${service.name}] port-forward supervisor failed to start: ${error.message}\n`);
  });

  process.stdout.write(`[portler] ${service.name}: ${assignment.url} -> ${name}:${service.port} (pid ${child.pid ?? 'unknown'})\n`);

  return child;
}

/** How a port-forward's pids.json entry names its process, so it can be told apart from a local one. */
export const K8S_FORWARD_COMMAND = 'portler __k8s-forward';

/** PID-file record for a port-forward supervisor so `portler down` can stop it. */
export async function portForwardPidInfo(
  config: PortlerConfig,
  service: ServiceConfig,
  child: ChildProcess,
  assignment: ServiceAssignment,
  image?: string,
): Promise<PidServiceInfo> {
  if (child.pid === undefined) {
    throw new Error(`port-forward for service "${service.name}" did not start with a process id`);
  }

  return {
    pid: child.pid,
    command: `${K8S_FORWARD_COMMAND} (kubectl port-forward service/${assignment.name} ${assignment.port}:${service.port})`,
    cwd: config.projectDir,
    port: assignment.port,
    url: assignment.url,
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    startedAt: new Date().toISOString(),
    runMode: 'k8s',
    // The --image pin, as a container entry records it: `env` rebuilds state from it.
    ...(image !== undefined ? { image } : {}),
  };
}
