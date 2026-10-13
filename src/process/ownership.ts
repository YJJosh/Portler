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
  | {
      status: 'found';
      id: string;
      labels: Record<string, string>;
      /** Containers only: `.State.Running` from the same inspect. */
      running?: boolean;
    }
  | { status: 'absent' }
  | { status: 'error'; message: string };

/**
 * The Go template asks docker to emit the id and the labels as one JSON object,
 * so the ID and the labels we authorize the removal on come from the SAME
 * inspect — they cannot drift apart between two calls.
 */
export function inspectArgs(kind: ResourceKind, name: string): string[] {
  const template =
    kind === 'container'
      ? '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}'
      : '{"id":{{json .Id}},"labels":{{json .Labels}}}';

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
    const parsed = JSON.parse(text) as { id?: unknown; labels?: unknown; running?: unknown };
    if (typeof parsed.id !== 'string' || parsed.id === '') {
      return { status: 'error', message: 'docker inspect returned no resource id' };
    }

    const labels =
      parsed.labels === null || parsed.labels === undefined
        ? {}
        : parseInspectLabels(JSON.stringify(parsed.labels));

    return { status: 'found', id: parsed.id, labels, ...(typeof parsed.running === 'boolean' ? { running: parsed.running } : {}) };
  } catch {
    return { status: 'error', message: `could not parse docker inspect output: ${text.slice(0, 120)}` };
  }
}

export async function inspectResource(kind: ResourceKind, name: string, run: CommandRunner = runCommand): Promise<Inspection> {
  const result = await run('docker', inspectArgs(kind, name));
  return parseInspection(result.code, result.stdout, result.stderr);
}

export type RemovalOutcome =
  /** `running` is the state Docker reported just before the removal, when it said. */
  | { status: 'removed'; id: string; running?: boolean }
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
  if (result.code === 0) {
    return { status: 'removed', id: inspection.id, ...(inspection.running !== undefined ? { running: inspection.running } : {}) };
  }

  // Someone removed it between the inspect and the rm — that is a success for us.
  if (isNotFoundError(result.stderr)) return { status: 'absent' };

  return { status: 'failed', message: result.stderr.trim().split('\n')[0] || `docker rm exited ${result.code}` };
}

/**
 * Remove a Docker container only when it carries this project's label, and only
 * by the ID captured while checking that label. A foreign container with a
 * colliding name is left strictly alone. `-v` drops the container's anonymous
 * volumes with it, as `docker run --rm` would have on a clean exit (an image
 * VOLUME such as postgres' data dir); named volumes are never touched.
 */
export function removeOwnedContainer(name: string, projectDir: string, run: CommandRunner = runCommand): Promise<RemovalOutcome> {
  return removeOwned('container', name, projectDir, (id) => ['rm', '-f', '-v', id], run);
}

export type ContainerLiveness =
  /** Carries this project's label and is running. */
  | { status: 'running'; id: string }
  /** No such container, a stranger's under that name, or ours but exited: nothing of the service is alive. */
  | { status: 'gone' }
  /** The daemon could not be asked (down, permission error, missing CLI). */
  | { status: 'error'; message: string };

/**
 * Whether this project's container of that name is still running. A `docker
 * run` container outlives the shell pid that supervises it, so a pids.json
 * entry whose pid is gone can still name a live service. Only a container that
 * carries this project's label counts: a stranger's container under the name
 * is not our service, and an exited one of ours is nothing to keep. A failed
 * inspect is reported as such, never guessed either way.
 */
export async function ownedContainerLiveness(
  name: string,
  projectDir: string,
  run: CommandRunner = runCommand,
): Promise<ContainerLiveness> {
  const inspection = await inspectResource('container', name, run);
  if (inspection.status === 'absent') return { status: 'gone' };
  if (inspection.status === 'error') return { status: 'error', message: inspection.message };
  if (ownershipVerdict(inspection.labels, projectDir) !== 'owned') return { status: 'gone' };
  return inspection.running === true ? { status: 'running', id: inspection.id } : { status: 'gone' };
}

export type MountedVolumeSet =
  /** Every Portler-managed volume it mounts belongs to this set ('' for the base volumes). */
  | { status: 'set'; set: string }
  /** It mounts no Portler-managed volume. */
  | { status: 'none' }
  /** Could not tell: the container is gone or not this project's, an inspect failed, or its volumes disagree. */
  | { status: 'unknown'; reason: string };

/**
 * The volume set a container of this project was started on, read from the
 * volumes mounted at its `@name` paths (`expected`): Portler labels every managed
 * volume `portler.volume`, and one made for a set also `portler.volume-set`. Other
 * volumes the container mounts do not follow the set and are not read. Entries in pids.json written
 * before the set was recorded have nothing else to go on, and guessing the base
 * volumes would bring a database back with other data. Anything short of a
 * clear answer is reported as unknown, never guessed.
 */
export async function mountedVolumeSet(
  name: string,
  projectDir: string,
  expected: ReadonlyArray<{ name: string; destination: string }>,
  volumeOwners: readonly string[],
  run: CommandRunner = runCommand,
): Promise<MountedVolumeSet> {
  const container = await run('docker', [
    'inspect',
    '--type',
    'container',
    '--format',
    '{"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}',
    name,
  ]);
  if (container.code !== 0) {
    if (isNotFoundError(container.stderr)) return { status: 'unknown', reason: 'its container is gone' };
    return { status: 'unknown', reason: container.stderr.trim().split('\n')[0] || `docker inspect exited ${container.code}` };
  }
  // Only the service's `@name` entries follow the volume set, so only the volumes mounted at
  // their paths vote; any other volume, Portler-labelled or not, says nothing about the set.
  const expectedAt = new Map(expected.map((mount) => [mount.destination, mount.name]));
  let volumes: Array<{ volume: string; managedName: string; destination: string }>;
  let elsewhere: Array<{ volume: string; destination: string }>;
  try {
    const parsed = JSON.parse(container.stdout.trim()) as { labels?: unknown; mounts?: unknown };
    const labels = parsed.labels === null || parsed.labels === undefined ? {} : parseInspectLabels(JSON.stringify(parsed.labels));
    if (ownershipVerdict(labels, projectDir) !== 'owned') return { status: 'unknown', reason: 'the container under its name is not this project\'s' };
    const mounts = Array.isArray(parsed.mounts) ? (parsed.mounts as Array<{ Type?: unknown; Name?: unknown; Destination?: unknown }>) : [];
    const named = mounts.flatMap((mount) =>
      mount.Type === 'volume' && typeof mount.Name === 'string' && mount.Name !== '' && typeof mount.Destination === 'string'
        ? [{ volume: mount.Name, destination: mount.Destination }]
        : [],
    );
    volumes = named.flatMap((mount) => {
      const managedName = expectedAt.get(mount.destination);
      return managedName === undefined ? [] : [{ ...mount, managedName }];
    });
    elsewhere = named.filter((mount) => !expectedAt.has(mount.destination));
  } catch {
    return { status: 'unknown', reason: 'could not parse docker inspect output' };
  }
  if (volumes.length === 0) {
    const moved = await movedManagedVolume(expected, elsewhere, volumeOwners, run);
    return moved ?? { status: 'none' };
  }

  const inspected = await run('docker', ['volume', 'inspect', '--format', '{{json .Labels}}', ...volumes.map((entry) => entry.volume)]);
  if (inspected.code !== 0) {
    return { status: 'unknown', reason: inspected.stderr.trim().split('\n')[0] || `docker volume inspect exited ${inspected.code}` };
  }
  const lines = inspected.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== volumes.length) return { status: 'unknown', reason: 'docker volume inspect returned an unexpected answer' };
  const sets = new Set<string>();
  let stranger: (typeof volumes)[number] | undefined;
  try {
    lines.forEach((line, index) => {
      const entry = volumes[index]!;
      const labels = parseInspectLabels(line);
      // The volume at a managed path must be that managed volume, and this project's. Anything
      // else there (a config change, a hand-made volume, another project's volume of the same
      // name) means the container's data came from somewhere Portler cannot name, so the answer
      // is unknown rather than "base": guessing base could restart the service on other data.
      if (labels['portler.volume'] !== entry.managedName || !volumeOwners.includes(labels[PROJECT_LABEL] ?? '')) {
        stranger ??= entry;
        return;
      }
      sets.add(labels['portler.volume-set'] ?? '');
    });
  } catch {
    return { status: 'unknown', reason: 'could not parse docker volume inspect output' };
  }
  if (stranger) {
    return { status: 'unknown', reason: `the volume at ${stranger.destination} (${stranger.volume}) is not this project's @${stranger.managedName} volume` };
  }
  const unmatched = expected.filter((mount) => !volumes.some((entry) => entry.destination === mount.destination));
  const moved = await movedManagedVolume(unmatched, elsewhere, volumeOwners, run);
  if (moved) return moved;
  if (sets.size === 0) return { status: 'none' };
  if (sets.size > 1) return { status: 'unknown', reason: 'it mounts volumes from different sets' };
  return { status: 'set', set: [...sets][0]! };
}

/**
 * For `@` entries with no volume at their path, look for this project's volume of that name
 * mounted somewhere else: the config moved the path since the container started, so its data
 * still came from that volume and the base set is not a safe guess. Returns an unknown answer
 * naming the volume, or undefined when nothing was moved (or nothing needs checking).
 */
async function movedManagedVolume(
  unmatched: ReadonlyArray<{ name: string; destination: string }>,
  elsewhere: ReadonlyArray<{ volume: string; destination: string }>,
  volumeOwners: readonly string[],
  run: CommandRunner,
): Promise<MountedVolumeSet | undefined> {
  if (unmatched.length === 0 || elsewhere.length === 0) return undefined;
  const inspected = await run('docker', ['volume', 'inspect', '--format', '{{json .Labels}}', ...elsewhere.map((entry) => entry.volume)]);
  if (inspected.code !== 0) {
    return { status: 'unknown', reason: inspected.stderr.trim().split('\n')[0] || `docker volume inspect exited ${inspected.code}` };
  }
  const lines = inspected.stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== elsewhere.length) return { status: 'unknown', reason: 'docker volume inspect returned an unexpected answer' };
  try {
    for (const [index, line] of lines.entries()) {
      const labels = parseInspectLabels(line);
      const mount = unmatched.find((entry) => entry.name === labels['portler.volume']);
      if (mount && volumeOwners.includes(labels[PROJECT_LABEL] ?? '')) {
        const found = elsewhere[index]!;
        return {
          status: 'unknown',
          reason: `this project's @${mount.name} volume (${found.volume}) is mounted at ${found.destination}, not at ${mount.destination} where the config now puts it`,
        };
      }
    }
  } catch {
    return { status: 'unknown', reason: 'could not parse docker volume inspect output' };
  }
  return undefined;
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
