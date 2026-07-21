import { isIP } from 'node:net';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { runStreaming } from './exec.ts';

export type ClusterType = 'kind' | 'minikube' | 'docker-desktop' | 'k3d' | 'rancher-desktop' | 'orbstack' | 'colima' | 'allowed';

export interface ClusterInfo {
  type: ClusterType;
  /** The kubectl context name. Pinned onto every kubectl call Portler makes. */
  context: string;
  /** kind cluster name / minikube profile, when derivable from the context. */
  name?: string;
  /** The API server URL the context resolves to, when it could be read. */
  server?: string;
}

/**
 * Escape hatch for a local cluster whose context name Portler does not
 * recognize. It must name the exact context, so enabling it is a deliberate
 * act — a bare "yes" flag would be far too easy to leave exported in a shell
 * that later points at production.
 */
export const CONTEXT_OVERRIDE_ENV = 'PORTLER_ALLOW_K8S_CONTEXT';

/**
 * Second escape hatch, for the endpoint gate below. Separate from the context
 * one on purpose: the two checks are independent, and a user who had to allow
 * an unusual context name should not thereby also silence the check that asks
 * where that context actually points.
 *
 * It must name the exact API server URL, and it is the ONLY way to authorize an
 * endpoint that is not unambiguously on this machine — including a private/LAN
 * address (see checkEndpointLocality).
 */
export const ENDPOINT_OVERRIDE_ENV = 'PORTLER_ALLOW_K8S_ENDPOINT';

const KNOWN_LOCAL_CONTEXTS: Array<{ type: ClusterType; matches: (context: string) => boolean; nameOf?: (context: string) => string }> = [
  { type: 'kind', matches: (c) => c.startsWith('kind-'), nameOf: (c) => c.slice('kind-'.length) },
  { type: 'k3d', matches: (c) => c.startsWith('k3d-'), nameOf: (c) => c.slice('k3d-'.length) },
  { type: 'minikube', matches: (c) => c === 'minikube', nameOf: (c) => c },
  { type: 'docker-desktop', matches: (c) => c === 'docker-desktop' || c === 'docker-for-desktop' },
  { type: 'rancher-desktop', matches: (c) => c === 'rancher-desktop' },
  { type: 'orbstack', matches: (c) => c === 'orbstack' },
  { type: 'colima', matches: (c) => c === 'colima' || c.startsWith('colima-') },
];

/**
 * Recognize a context name as a local development cluster. Returns null for
 * anything unrecognized — which Portler treats as "could be production".
 */
export function classifyContext(context: string): ClusterInfo | null {
  for (const candidate of KNOWN_LOCAL_CONTEXTS) {
    if (!candidate.matches(context)) continue;
    const name = candidate.nameOf?.(context);
    return name === undefined ? { type: candidate.type, context } : { type: candidate.type, context, name };
  }

  return null;
}

/**
 * Resolve the cluster Portler will act on, given the active context name and
 * the override env value. Unrecognized contexts FAIL: `portler up k8s` applies
 * manifests and `portler down k8s` deletes namespaces, and doing either against
 * a shared staging or production cluster because it happened to be the active
 * context is not a recoverable mistake.
 *
 * Pure, so the whole policy is unit-testable without a cluster.
 */
export function resolveCluster(context: string, override: string | undefined): ClusterInfo {
  const local = classifyContext(context);
  if (local) return local;

  if (override !== undefined && override.trim() === context && context !== '') {
    return { type: 'allowed', context };
  }

  throw new Error(
    `refusing to use kubectl context "${context}": Portler only targets local development clusters ` +
      '(kind, k3d, minikube, Docker Desktop, Rancher Desktop, OrbStack, colima). ' +
      `"portler up k8s" applies manifests and "portler down k8s" deletes resources, so it will not act on an ` +
      `unrecognized cluster. Switch context with "kubectl config use-context <local>", or — only if this really ` +
      `is a local cluster — set ${CONTEXT_OVERRIDE_ENV}="${context}".`,
  );
}

/** Where the context's API server actually lives. */
export type EndpointLocality =
  /** 127.0.0.0/8, ::1, localhost, or a known local-runtime host alias — certainly this machine. */
  | 'loopback'
  /**
   * An RFC1918 / CGNAT / link-local / ULA address. It MIGHT be a VM on this host
   * (minikube's 192.168.49.2), and it might equally be the cluster on the rack
   * down the hall, or a colleague's machine over the VPN. Portler cannot tell
   * those apart, so this is not auto-accepted.
   */
  | 'private'
  /** A routable address or a real DNS name — could be anyone's cluster. */
  | 'remote'
  /** No endpoint, or one we cannot parse. */
  | 'unknown';

/** Host aliases the local-cluster runtimes publish their API server under. */
const LOCAL_HOST_ALIASES = new Set([
  'localhost',
  'kubernetes.docker.internal',
  'host.docker.internal',
  'host.lima.internal',
  'host.orb.internal',
  'docker-for-desktop',
]);

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.');
  if (octets.length !== 4 || !octets.every((part) => /^\d{1,3}$/.test(part))) return false;

  const [a, b] = octets.map(Number) as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local (169.254/16) and CGNAT (100.64/10, used by some VM networks).
  if (a === 169 && b === 254) return true;

  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Classify the API server endpoint of a context. This is the second, INDEPENDENT
 * locality gate: the context NAME is a convention (anyone can name a production
 * context "minikube", and `kubectl config rename-context` takes two seconds),
 * while the server URL is what kubectl will actually talk to.
 *
 * Pure, so every case is unit-testable without a cluster.
 */
export function classifyApiEndpoint(server: string | undefined): EndpointLocality {
  const text = (server ?? '').trim();
  if (text === '') return 'unknown';

  let hostname: string;
  try {
    hostname = new URL(text).hostname;
  } catch {
    return 'unknown';
  }

  // URL keeps IPv6 literals in brackets.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === '') return 'unknown';

  if (host === '::1' || host === '0.0.0.0') return 'loopback';
  // A textual prefix is not an IP check: `127.production.example.com` and
  // `127.0.0.1.attacker.example` are ordinary DNS names and may resolve anywhere.
  if (isIP(host) === 4 && Number(host.split('.')[0]) === 127) return 'loopback';
  if (LOCAL_HOST_ALIASES.has(host) || host.endsWith('.localhost')) return 'loopback';
  if (isPrivateIpv4(host)) return 'private';
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]*:/.test(host) || host.startsWith('fe80:')) return 'private';

  return 'remote';
}

/** Read the API server URL the context resolves to. Null when kubectl cannot tell us. */
export async function readContextServer(context: string, run: CommandRunner = runCommand): Promise<string | null> {
  const result = await run('kubectl', [
    'config',
    'view',
    '--minify',
    '--context',
    context,
    '-o',
    'jsonpath={.clusters[0].cluster.server}',
  ]);

  if (result.code !== 0) return null;

  return result.stdout.trim() || null;
}

function nonLocalEndpointError(context: string, server: string, locality: EndpointLocality): Error {
  const what =
    locality === 'private'
      ? 'a private/LAN address. Portler cannot tell a VM on this machine (minikube) apart from a cluster elsewhere ' +
        'on your network or across a VPN, so it does not accept private addresses on its own'
      : 'not a local endpoint';

  return new Error(
    `refusing to use kubectl context "${context}": its API server is ${server}, which is ${what}. ` +
      'Portler applies manifests and deletes namespaces, so it only acts on a cluster it can tell is on this machine ' +
      '(a loopback address, or a local runtime\'s host alias). A context can be NAMED anything — the endpoint is what ' +
      `it actually talks to. If this really is your local cluster, authorize that exact endpoint: ` +
      `${ENDPOINT_OVERRIDE_ENV}="${server}".`,
  );
}

function unreadableEndpointError(context: string, server: string | null): Error {
  const detail =
    server === null || server.trim() === ''
      ? 'kubectl reported no API server URL for it'
      : `its API server URL (${server}) could not be parsed`;

  return new Error(
    `refusing to use kubectl context "${context}": ${detail}, so Portler cannot tell which cluster it points at. ` +
      'The context name alone is not evidence — anything can be named "minikube". Check the context with ' +
      `"kubectl config view --minify --context ${context}". This gate has no override: an endpoint Portler cannot ` +
      `read is not one it can authorize (${ENDPOINT_OVERRIDE_ENV} names an exact URL, and there is none here).`,
  );
}

/**
 * Decide whether a resolved endpoint is acceptable. Split out from detectCluster
 * so the whole policy is testable without a cluster.
 *
 * FAIL CLOSED. Only an endpoint that is unambiguously on this machine —
 * loopback, or a host alias a local runtime publishes — is accepted on its own.
 * Everything else needs the user to name that exact URL in the override env var:
 *
 * - 'remote'  : a routable address or DNS name. Could be production.
 * - 'private' : an RFC1918/CGNAT/link-local/ULA address. minikube's VM lives
 *   here — and so does the shared cluster on the office LAN, and so does a
 *   cluster on the other end of a VPN. "Private" means "not routable from the
 *   internet", NOT "on this machine", and Portler used to conflate the two.
 * - 'unknown' : no endpoint, or one we cannot parse. Previously a warning; a tool
 *   that deletes namespaces must not proceed against a cluster it cannot even
 *   identify. There is deliberately no override for this case — the override
 *   names a URL, and here there is no usable URL to name.
 */
export function checkEndpointLocality(context: string, server: string | null, override: string | undefined): void {
  const locality = classifyApiEndpoint(server ?? undefined);

  if (locality === 'loopback') return;

  if (locality === 'unknown') throw unreadableEndpointError(context, server);

  if (override !== undefined && server !== null && override.trim() === server.trim()) {
    process.stderr.write(
      `[portler] warning: API server ${server} is not a loopback endpoint, but ${ENDPOINT_OVERRIDE_ENV} names it ` +
        'explicitly; continuing.\n',
    );
    return;
  }

  throw nonLocalEndpointError(context, server!, locality);
}

/**
 * Detect the active kubectl context, verify it is a local cluster BY NAME and BY
 * ENDPOINT, and pin it. Every kubectl call Portler makes afterwards passes
 * `--context <this>`, so a context switch mid-run (by the user, a script, or
 * another tool) cannot redirect an apply or a delete to another cluster.
 */
export async function detectCluster(run: CommandRunner = runCommand): Promise<ClusterInfo> {
  const current = await run('kubectl', ['config', 'current-context']);
  if (current.code !== 0) {
    throw new Error(
      'could not determine the active kubectl context. Is a local cluster running?\n' +
        (current.stderr.trim() || `kubectl config current-context exited ${current.code}`),
    );
  }

  const context = current.stdout.trim();
  const cluster = resolveCluster(context, process.env[CONTEXT_OVERRIDE_ENV]);
  const server = await readContextServer(context, run);

  checkEndpointLocality(context, server, process.env[ENDPOINT_OVERRIDE_ENV]);

  return server === null ? cluster : { ...cluster, server };
}

/**
 * Make a locally built Docker image visible to the cluster. kind/k3d/minikube
 * run their own container runtime, so images must be loaded explicitly; Docker
 * Desktop, Rancher Desktop, OrbStack and colima share the host Docker daemon,
 * so nothing is needed. No registry push is ever required.
 */
export async function loadImageIntoCluster(cluster: ClusterInfo, image: string): Promise<void> {
  switch (cluster.type) {
    case 'kind': {
      const args = ['load', 'docker-image', image];
      if (cluster.name) args.push('--name', cluster.name);
      await runStreaming('kind', args, 'portler');
      return;
    }
    case 'k3d': {
      const args = ['image', 'import', image];
      if (cluster.name) args.push('--cluster', cluster.name);
      await runStreaming('k3d', args, 'portler');
      return;
    }
    case 'minikube':
      await runStreaming('minikube', ['image', 'load', image], 'portler');
      return;
    case 'docker-desktop':
    case 'rancher-desktop':
    case 'orbstack':
    case 'colima':
      return;
    case 'allowed':
      process.stderr.write(
        `[portler] warning: context "${cluster.context}" was allowed via ${CONTEXT_OVERRIDE_ENV} but its flavor is ` +
          `unknown; skipping image load for ${image}. Locally built images may not be pullable.\n`,
      );
  }
}
