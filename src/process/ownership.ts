/**
 * Docker ownership. A name is not a claim (users set `container_name`/`docker_network` freely):
 * every removal inspects ID and project label in one call, checks the label, then removes by ID,
 * since the name can point elsewhere by the time `rm` runs. A failed inspect is an error, never 'absent'.
 */
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';

/** Holds the owning project directory; volumes use the same label. */
export const PROJECT_LABEL = 'portler.project';
export const SERVICE_LABEL = 'portler.service';

export type OwnershipVerdict =
  /** Labelled as ours: safe to remove. */
  | 'owned'
  /** Unlabelled or another project's: never touch it. */
  | 'foreign'
  /** No such resource. */
  | 'absent';

/** `labels === null`: the resource does not exist. Unlabelled is 'foreign': not provably ours. */
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

/** One inspect returns both ID and labels, so a removal is authorized on the resource it removes. */
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
    // Only "no such object" is absent: a dead daemon, EPERM or no binary must not read as removed.
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
  /** Could not inspect it (daemon or permission error). */
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

  // Removed by someone else since the inspect: a success.
  if (isNotFoundError(result.stderr)) return { status: 'absent' };

  return { status: 'failed', message: result.stderr.trim().split('\n')[0] || `docker rm exited ${result.code}` };
}

/**
 * Removes by the ID whose label was checked; a foreign one is left alone. `-v` also drops its
 * anonymous volumes (an image VOLUME such as postgres' data), as `--rm` would; named ones stay.
 */
export function removeOwnedContainer(name: string, projectDir: string, run: CommandRunner = runCommand): Promise<RemovalOutcome> {
  return removeOwned('container', name, projectDir, (id) => ['rm', '-f', '-v', id], run);
}

export type ContainerLiveness =
  /** Carries this project's label and is running. */
  | { status: 'running'; id: string }
  /** Absent, a stranger's under that name, or ours but exited. */
  | { status: 'gone' }
  /** The daemon could not be asked (down, permission error, missing CLI). */
  | { status: 'error'; message: string };

/**
 * A `docker run` container outlives its shell pid. Only a running container with this project's
 * label counts; a failed inspect is reported, never guessed.
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
  /** The container is gone or not ours, an inspect failed, or its volumes disagree. */
  | { status: 'unknown'; reason: string };

/**
 * The set a container started on, from the labels of the volumes at its `@name` paths. Anything
 * unclear is 'unknown': guessing the base set could bring a database back on other data.
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
  // Only volumes at the `@name` paths follow the set; other mounts say nothing about it.
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
      // Not this project's managed volume at a managed path: data Portler cannot name, so
      // unknown, not base (which could restart the service on other data).
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

// This project's `@` volume mounted away from its configured path means the config moved it,
// so the base set is not a safe guess: 'unknown', naming the volume.
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

/** Removes the network by ID, only when it carries this project's label. */
export function removeOwnedNetwork(name: string, projectDir: string, run: CommandRunner = runCommand): Promise<RemovalOutcome> {
  return removeOwned('network', name, projectDir, (id) => ['network', 'rm', id], run);
}

export function warnForeignResource(kind: ResourceKind, name: string): void {
  process.stderr.write(
    `[portler] warning: ${kind} "${name}" exists but is not labelled as this project's ` +
      `(${PROJECT_LABEL}), so Portler will not remove it. Remove it manually if it is stale.\n`,
  );
}
