/**
 * Docker resource ownership. Container and network names are derived from the
 * project directory, but a name is not a claim: an unrelated container can
 * already hold the name Portler wants (the hash makes it unlikely, not
 * impossible — and users can set `container_name`/`docker_network` freely).
 *
 * `docker rm -f <name>` on such a collision would destroy a stranger's
 * container. So every resource Portler creates is labelled with the project it
 * belongs to, and every removal:
 *
 * 1. inspects the resource, capturing its immutable ID together with its labels
 *    in ONE call,
 * 2. verifies the label,
 * 3. removes it BY ID.
 *
 * Removing by name would re-resolve the name at removal time: between the
 * inspect and the `rm`, a container can be replaced by a different one under
 * the same name (`docker run --name` after a stop), and the verified label
 * would then belong to a container that no longer exists. An ID never moves.
 *
 * A failed inspect is not the same as "no such resource": a stopped daemon, a
 * permission error, or a missing docker CLI all fail too, and treating those as
 * 'absent' would silently report a successful cleanup that never happened.
 */
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';

/** Label carrying the owning project directory. Matches the volume convention. */
export const PROJECT_LABEL = 'portler.project';
export const SERVICE_LABEL = 'portler.service';

export type OwnershipVerdict =
  /** Labelled as ours — safe to remove. */
  | 'owned'
  /** Exists but is not ours (unlabelled, or another project) — must not be touched. */
  | 'foreign'
  /** No such resource — nothing to remove. */
  | 'absent';

/**
 * Classify a Docker resource from its labels. `labels === null` means the
 * resource does not exist. An unlabelled resource is deliberately 'foreign':
 * we cannot prove we created it, and destroying data on a guess is exactly the
 * failure this module exists to prevent.
 */
export function ownershipVerdict(labels: Record<string, string> | null, projectDir: string): OwnershipVerdict {
  if (labels === null) return 'absent';
  return labels[PROJECT_LABEL] === projectDir ? 'owned' : 'foreign';
}

/** `docker run` / `docker network create` label flags marking a resource as ours. */
export function dockerLabelArgs(projectDir: string, serviceName?: string): string[] {
  const args = ['--label', `${PROJECT_LABEL}=${projectDir}`];
  if (serviceName !== undefined) args.push('--label', `${SERVICE_LABEL}=${serviceName}`);
  return args;
}

/** Parse a `{{json .Labels}}` fragment ("null" when the resource is unlabelled). */
export function parseInspectLabels(stdout: string): Record<string, string> {
  const text = stdout.trim();
  if (!text || text === 'null') return {};

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export type ResourceKind = 'container' | 'network';

export type Inspection =
  | { status: 'found'; id: string; labels: Record<string, string> }
  | { status: 'absent' }
  | { status: 'error'; message: string };

/**
 * The Go template asks docker to emit the id and the labels as one JSON object,
 * so the ID and the labels we authorize the removal on come from the SAME
 * inspect — they cannot drift apart between two calls.
 */
export function inspectArgs(kind: ResourceKind, name: string): string[] {
  const template = kind === 'container' ? '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}' : '{"id":{{json .Id}},"labels":{{json .Labels}}}';

  return kind === 'container'
    ? ['inspect', '--type', 'container', '--format', template, name]
    : ['network', 'inspect', '--format', template, name];
}

/** docker's "no such object" wording, across versions and resource kinds. */
export function isNotFoundError(stderr: string): boolean {
  return /no such (container|network|object)|not found/i.test(stderr);
}

export function parseInspection(code: number, stdout: string, stderr: string): Inspection {
  if (code !== 0) {
    // ONLY a genuine "no such object" is absent. A dead daemon ("Cannot connect
    // to the Docker daemon"), a permission error, or a missing binary must not
    // masquerade as a clean, already-removed resource.
    if (isNotFoundError(stderr)) return { status: 'absent' };
    return { status: 'error', message: stderr.trim().split('\n')[0] || `docker inspect exited ${code}` };
  }

  const text = stdout.trim();
  if (!text) return { status: 'error', message: 'docker inspect returned no output' };

  try {
    const parsed = JSON.parse(text) as { id?: unknown; labels?: unknown };
    if (typeof parsed.id !== 'string' || parsed.id === '') {
      return { status: 'error', message: 'docker inspect returned no resource id' };
    }

    const labels =
      parsed.labels === null || parsed.labels === undefined
        ? {}
        : parseInspectLabels(JSON.stringify(parsed.labels));

    return { status: 'found', id: parsed.id, labels };
  } catch {
    return { status: 'error', message: `could not parse docker inspect output: ${text.slice(0, 120)}` };
  }
}

export async function inspectResource(kind: ResourceKind, name: string, run: CommandRunner = runCommand): Promise<Inspection> {
  const result = await run('docker', inspectArgs(kind, name));
  return parseInspection(result.code, result.stdout, result.stderr);
}

export type RemovalOutcome =
  | { status: 'removed'; id: string }
  | { status: 'absent' }
  | { status: 'foreign' }
  /** The resource is ours but `docker rm` failed. */
  | { status: 'failed'; message: string }
  /** We could not even establish what the resource is (daemon/permission error). */
  | { status: 'error'; message: string };

async function removeOwned(
  kind: ResourceKind,
  name: string,
  projectDir: string,
  removeArgs: (id: string) => string[],
  run: CommandRunner,
): Promise<RemovalOutcome> {
  const inspection = await inspectResource(kind, name, run);

  if (inspection.status === 'absent') return { status: 'absent' };
  if (inspection.status === 'error') return { status: 'error', message: inspection.message };

  if (ownershipVerdict(inspection.labels, projectDir) !== 'owned') return { status: 'foreign' };

  // By ID: the name may already point at a different resource.
  const result = await run('docker', removeArgs(inspection.id));
  if (result.code === 0) return { status: 'removed', id: inspection.id };

  // Someone removed it between the inspect and the rm — that is a success for us.
  if (isNotFoundError(result.stderr)) return { status: 'absent' };

  return { status: 'failed', message: result.stderr.trim().split('\n')[0] || `docker rm exited ${result.code}` };
}

/**
 * Remove a Docker container only when it carries this project's label, and only
 * by the ID captured while checking that label. A foreign container with a
 * colliding name is left strictly alone.
 */
export function removeOwnedContainer(name: string, projectDir: string, run: CommandRunner = runCommand): Promise<RemovalOutcome> {
  return removeOwned('container', name, projectDir, (id) => ['rm', '-f', id], run);
}

/** Remove a Docker network only when it carries this project's label (by ID). */
export function removeOwnedNetwork(name: string, projectDir: string, run: CommandRunner = runCommand): Promise<RemovalOutcome> {
  return removeOwned('network', name, projectDir, (id) => ['network', 'rm', id], run);
}

/** Warn (once, specifically) about a name collision we refused to act on. */
export function warnForeignResource(kind: ResourceKind, name: string): void {
  process.stderr.write(
    `[portler] warning: ${kind} "${name}" exists but is not labelled as this project's ` +
      `(${PROJECT_LABEL}), so Portler will not remove it. Remove it manually if it is stale.\n`,
  );
}
