import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { formatYamlDocuments } from '../parse/yaml-format.ts';
import { prefixStream, readProcessStartToken } from '../process/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { sleep } from '../util/sleep.ts';
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
 * Pin the cluster on every kubectl invocation. Reading `current-context` once
 * and then running bare `kubectl` would leave a window in which a context
 * switch (by the user, another tool, or a script) silently redirects Portler's
 * applies and deletes to a different cluster.
 */
function kubectlArgs(cluster: ClusterInfo, args: string[]): string[] {
  return ['--context', cluster.context, ...args];
}

/** Apply a set of generated manifest files (or a whole directory). */
export async function applyManifestFiles(cluster: ClusterInfo, paths: string[]): Promise<void> {
  const args = ['apply'];
  for (const manifestPath of paths) args.push('-f', manifestPath);
  await runStreaming('kubectl', kubectlArgs(cluster, args), 'portler');
}

/** Wait until the service's Deployment has rolled out (pods ready). */
export async function waitForRollout(cluster: ClusterInfo, config: PortlerConfig, serviceName: string, name: string): Promise<void> {
  await runStreaming(
    'kubectl',
    kubectlArgs(cluster, ['rollout', 'status', `deployment/${name}`, '--namespace', config.k8sNamespace, `--timeout=${ROLLOUT_TIMEOUT}`]),
    serviceName,
  );
}

interface PodSnapshot {
  podCount: number;
  allReady: boolean;
  restarts: number;
}

async function podSnapshot(cluster: ClusterInfo, namespace: string, appName: string): Promise<PodSnapshot> {
  const raw = await captureOutput(
    'kubectl',
    kubectlArgs(cluster, ['get', 'pods', '--namespace', namespace, '--selector', `app=${appName}`, '-o', 'json']),
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
 * `kubectl rollout status` returns as soon as a pod reports ready once, which
 * for containers without a readiness probe just means the process started. A
 * pod whose command fails (e.g. a migration against a database that is not
 * accepting connections yet) becomes "ready", crashes, and enters BackOff —
 * killing any port-forward attached to it. Require the pods to stay ready with
 * no new restarts for a short window before declaring the service stable.
 */
export async function waitForStablePods(
  cluster: ClusterInfo,
  config: PortlerConfig,
  serviceName: string,
  name: string,
): Promise<void> {
  const deadline = Date.now() + STABILITY_TIMEOUT_MS;
  let baseline = await podSnapshot(cluster, config.k8sNamespace, name);
  let windowStart = Date.now();

  while (Date.now() < deadline) {
    await sleep(STABILITY_POLL_MS);
    const snapshot = await podSnapshot(cluster, config.k8sNamespace, name);

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
 * A namespace read, with the three outcomes kept apart.
 *
 * The distinction is the whole point: "the namespace does not exist" licenses
 * Portler to create and later delete it, while "the API server refused us / is
 * unreachable" licenses nothing at all. Collapsing an auth error or a dead
 * cluster into 'absent' is how a tool ends up deciding it owns a namespace it
 * has never actually seen.
 */
export type NamespaceRead =
  | { status: 'found'; labels: Record<string, string> }
  | { status: 'absent' }
  | { status: 'error'; message: string };

/**
 * True ONLY for the API server's own "this namespace does not exist" answer:
 *
 *   Error from server (NotFound): namespaces "portler-app" not found
 *
 * The previous matcher was `/\bnotfound\b|not found/i`, which also matched every
 * OTHER "not found" kubectl can print — and those mean the opposite of "the
 * namespace is absent":
 *
 *   - `kubectl: command not found` (via a shell wrapper)
 *   - `getting credentials: exec: executable gke-gcloud-auth-plugin not found`
 *   - `error: You must be logged in to the server` / `no such host` on some paths
 *
 * Reading any of those as 'absent' tells Portler "the namespace does not exist",
 * which is exactly the licence to create-and-later-delete that the ownership gate
 * exists to withhold. A broken credential helper must be an operational error.
 *
 * Matching requires BOTH the NotFound signal and the namespaces resource, so a
 * NotFound about some other kind (a Deployment, a Secret) does not qualify
 * either — this function only ever answers a namespace read.
 */
export function isNamespaceNotFound(stderr: string): boolean {
  const text = stderr.trim();
  if (text === '') return false;

  const mentionsNamespace = /\bnamespaces?\b/i.test(text);
  if (!mentionsNamespace) return false;

  // The canonical API-server error, and the bare form some kubectl versions print.
  if (/error from server \(notfound\)/i.test(text)) return true;

  return /\bnamespaces?\s+"[^"]*"\s+not found\b/i.test(text);
}

export function namespaceReadArgs(cluster: ClusterInfo, namespace: string): string[] {
  // `-o json` returns the real object. The previous `-o jsonpath={.metadata.labels}`
  // did NOT return JSON: kubectl renders a map with Go's fmt, so an unlabelled
  // namespace printed `map[]` and a labelled one `map[a:b]` — JSON.parse threw,
  // the catch turned it into "no labels", and a namespace with our labels could
  // be read as unowned (or a foreign one as claimable).
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
): Promise<string | null> {
  const result = await run('kubectl', kubectlArgs(cluster, ['get', 'namespace', namespace, '-o', 'jsonpath={.status.phase}']));

  if (result.code !== 0) {
    if (isNamespaceNotFound(result.stderr)) return null;
    throw new Error(`could not read namespace ${namespace}: ${result.stderr.trim().split('\n')[0] || `exit ${result.code}`}`);
  }

  return result.stdout.trim() || null;
}

/**
 * Poll until the namespace is fully gone; true when deleted within the timeout.
 * Deletion must be confirmed POSITIVELY (a NotFound read): an API error is
 * treated as "still there", never as a successful deletion.
 */
export async function waitForNamespaceDeleted(
  cluster: ClusterInfo,
  namespace: string,
  timeoutMs: number,
  run: CommandRunner = runCommand,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const gone = await getNamespacePhase(cluster, namespace, run).then(
      (phase) => phase === null,
      () => false,
    );
    if (gone) return true;
    if (Date.now() >= deadline) return false;

    await sleep(1_000);
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
 * Classify a namespace from its labels. An existing namespace that is NOT
 * labelled as ours is 'foreign' even if the name matches: it may be a shared
 * team namespace (or `default`) that a user pointed `k8s_namespace:` at, and
 * `kubectl delete namespace` on it would take everyone else's workloads with
 * it. Portler neither claims nor deletes such a namespace.
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
 * Ownership gate that touches nothing: fails on a foreign namespace and on an
 * unreadable one, and is happy with both 'owned' and 'absent'. Runs before any
 * port is reserved so `up k8s` aborts early.
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
  // `create`, never `apply`. `apply` would happily ADOPT a namespace that
  // appeared between our check and this command — stamping our labels onto a
  // stranger's namespace and thereby authorizing a later `down --volumes` to
  // delete it. `create` fails with AlreadyExists instead, which we then handle
  // by re-reading the namespace and refusing unless it is genuinely ours.
  return kubectlArgs(cluster, ['create', '-f', '-']);
}

/** kubectl's AlreadyExists wording for a create that lost a race. */
export function isAlreadyExistsError(stderr: string): boolean {
  return /alreadyexists|already exists/i.test(stderr);
}

/**
 * Make sure the project's namespace exists and is ours, creating it when it is
 * absent. This is the ONLY place a namespace comes into being; it is never part
 * of the manifest set that `up k8s` applies.
 *
 * The race this closes: check says "absent", someone else (a colleague's
 * script, a helm chart) creates the namespace, and our apply then adopts it.
 * `kubectl create` fails on AlreadyExists, and the re-read decides: ours (fine,
 * we simply lost a race with another Portler run) or foreign (abort).
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
   * Also delete PersistentVolumeClaims (and, for a full teardown, the
   * namespace itself, which cascades to its PVCs). Off by default: a database's
   * data must survive an ordinary `portler down k8s`.
   */
  deleteVolumes?: boolean;
  /** Block (bounded) until a deleted namespace is fully gone. */
  awaitNamespace?: boolean;
}

/**
 * Label selector restricting a delete to resources this project owns. Even for
 * a partial delete by service name, the project label is required: `app in
 * (api)` alone would match another project's `api` Deployment if the two ever
 * shared a namespace.
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

/**
 * Delete the generated Kubernetes resources. Ownership is verified first: a
 * namespace Portler did not create is never touched.
 *
 * By default this deletes Deployments and Services and LEAVES the namespace and
 * any PersistentVolumeClaims in place, so `portler down k8s && portler up k8s`
 * keeps a database's data. `deleteVolumes` opts into the destructive path
 * (`down k8s --volumes`), which for a full teardown deletes the whole
 * project-owned namespace.
 */
export async function deleteK8sResources(
  cluster: ClusterInfo,
  config: PortlerConfig,
  options: DeleteK8sOptions = {},
  run: CommandRunner = runCommand,
): Promise<void> {
  const { serviceNames, deleteVolumes = false, awaitNamespace = false } = options;
  const namespace = config.k8sNamespace;

  // An unreadable namespace is NOT an absent one: reporting "nothing to delete"
  // because the cluster was unreachable is a false all-clear, and the caller
  // would go on to release the ports and forget the state.
  const read = await readNamespace(cluster, namespace, run);
  if (read.status === 'error') throw namespaceReadError(namespace, read.message);
  if (read.status === 'absent') return;

  const ownership = namespaceOwnership(read.labels, config);
  if (ownership === 'foreign') throw foreignNamespaceError(namespace);

  // Full teardown WITH volumes: drop the namespace, which cascades everything.
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
    return;
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
    ]),
  );

  const what = serviceNames ? `for: ${serviceNames.join(', ')}` : `in namespace ${namespace}`;

  // A failed delete used to print a warning and return normally, so `down`
  // exited 0 and released the ports while the Deployments were still running.
  if (deleted.code !== 0) {
    throw new Error(
      `could not delete Kubernetes resources ${what}: ${deleted.stderr.trim().split('\n')[0] || `exit ${deleted.code}`}`,
    );
  }

  process.stdout.write(`[portler] deleted Kubernetes resources ${what}\n`);
  if (!deleteVolumes) {
    process.stdout.write('[portler] kept PersistentVolumeClaims; pass --volumes to delete stored data too\n');
  }
}

/**
 * Start the port-forward supervisor for a service: a small standalone
 * `portler __k8s-forward` process that runs `kubectl port-forward` in a loop,
 * re-spawning it (with capped backoff) when a pod restart kills it. The
 * supervisor is the tracked pid: it survives a detached `up k8s -d`, and
 * because it runs in its own process group with kubectl inside it,
 * stopServices' group signal tears both down.
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

  // Re-exec the running Portler entrypoint (dev .ts or built .js alike) so
  // the supervisor needs no extra install and inherits the same node flags.
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

/** PID-file record for a port-forward supervisor so `portler down` can kill it. */
export async function portForwardPidInfo(
  config: PortlerConfig,
  service: ServiceConfig,
  child: ChildProcess,
  assignment: ServiceAssignment,
): Promise<PidServiceInfo> {
  if (child.pid === undefined) {
    throw new Error(`port-forward for service "${service.name}" did not start with a process id`);
  }

  return {
    pid: child.pid,
    command: `portler __k8s-forward (kubectl port-forward service/${assignment.name} ${assignment.port}:${service.port})`,
    cwd: config.projectDir,
    port: assignment.port,
    url: assignment.url,
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    startedAt: new Date().toISOString(),
  };
}
