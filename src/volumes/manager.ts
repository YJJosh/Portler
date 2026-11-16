import { randomUUID } from 'node:crypto';
import {
  managedVolumeName,
  normalizeVolumeSet,
  normalizeVolumeToken,
  VOLUME_SET_SEPARATOR,
  volumeFullName,
  volumeLabelArgs,
  volumeScope,
} from '../config/index.ts';
import { ownershipVerdict, parseInspectLabels, PROJECT_LABEL } from '../process/ownership.ts';
import type { OwnershipVerdict } from '../process/ownership.ts';
import { dockerOrThrow, ensureDockerRunning, runDocker } from './docker.ts';
import type { PortlerConfig } from '../types/index.ts';

const COPY_IMAGE = 'alpine:3';

/**
 * A random token per fork attempt. The project label cannot tell concurrent forks
 * apart, and `docker volume create` succeeds for an existing name, so only this
 * proves the attempt created the target it copies into and may roll back.
 */
const FORK_ATTEMPT_LABEL = 'portler.fork-attempt';

export interface ProjectVolume {
  fullName: string;
  /** Short name as declared in portler.yml. */
  name: string;
  volumeSet?: string;
  driver?: string;
  /** Human-readable size from `docker system df -v`, when available. */
  size?: string;
  usedBy: string[];
  /** Services declaring this volume in portler.yml (empty for undeclared leftovers). */
  services: string[];
  /** False for volumes declared in portler.yml that Docker has not created yet. */
  exists: boolean;
}

export interface ForkResult {
  source: string;
  target: string;
  volumeSet: string;
}

export function parseProjectVolumeName(
  config: PortlerConfig,
  fullName: string,
): { name: string; volumeSet?: string } | undefined {
  const prefix = volumeScope(config).prefix;
  if (!fullName.startsWith(prefix)) return undefined;

  const rest = fullName.slice(prefix.length);
  const separatorIndex = rest.indexOf(VOLUME_SET_SEPARATOR);
  if (separatorIndex === -1) return { name: rest };

  return {
    name: rest.slice(0, separatorIndex),
    volumeSet: rest.slice(separatorIndex + VOLUME_SET_SEPARATOR.length),
  };
}

/**
 * Resolve a user-supplied volume argument to a full Docker volume name.
 * Accepts the full name, the short name from portler.yml (`postgres-data`,
 * with or without the `@`), or a short name with an explicit set
 * (`postgres-data--migration`). Bare short names follow the active volume set.
 */
export function resolveVolumeName(config: PortlerConfig, volumeArg: string): string {
  const prefix = volumeScope(config).prefix;
  if (volumeArg.startsWith(prefix)) return volumeArg;
  if (volumeArg.startsWith('portler-')) {
    throw new Error(`volume "${volumeArg}" does not belong to this project (expected prefix "${prefix}")`);
  }

  const short = volumeArg.startsWith('@') ? volumeArg.slice(1) : volumeArg;
  const separatorIndex = short.indexOf(VOLUME_SET_SEPARATOR);

  if (separatorIndex === -1) {
    return volumeFullName(volumeScope(config).prefix, normalizeVolumeToken(short, 'volume name'), config.volumeSet);
  }

  const name = normalizeVolumeToken(short.slice(0, separatorIndex), 'volume name');
  const volumeSet = normalizeVolumeSet(short.slice(separatorIndex + VOLUME_SET_SEPARATOR.length));
  return volumeFullName(volumeScope(config).prefix, name, volumeSet);
}

function declaredServicesFor(config: PortlerConfig, volumeName: string): string[] {
  return config.volumes.find((volume) => volume.name === volumeName)?.services ?? [];
}

async function volumeSizes(): Promise<Map<string, string>> {
  const sizes = new Map<string, string>();
  const result = await runDocker(['system', 'df', '-v', '--format', '{{ json .Volumes }}']);
  if (result.code !== 0) return sizes;

  try {
    const entries: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(entries)) return sizes;
    for (const entry of entries) {
      if (typeof entry === 'object' && entry !== null) {
        const { Name, Size } = entry as { Name?: unknown; Size?: unknown };
        if (typeof Name === 'string' && typeof Size === 'string') sizes.set(Name, Size);
      }
    }
  } catch {
    // Older Docker versions render this format differently; sizes stay blank.
  }

  return sizes;
}

/**
 * Names of running containers mounting the volume. A failed query throws: it is not
 * proof that nothing uses the volume, so fork and remove refuse. `bestEffort` (the
 * `volumes` listing) shows nobody instead.
 */
async function containersUsing(fullName: string, bestEffort = false): Promise<string[]> {
  const query = ['ps', '--filter', `volume=${fullName}`, '--format', '{{.Names}}'];
  let output: string;
  if (bestEffort) {
    const result = await runDocker(query);
    if (result.code !== 0) return [];
    output = result.stdout;
  } else {
    output = await dockerOrThrow(query);
  }
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Existing volumes with the project prefix, plus declared ones Docker has not created yet (exists: false). */
export async function listProjectVolumes(config: PortlerConfig): Promise<ProjectVolume[]> {
  await ensureDockerRunning();

  const scope = volumeScope(config);
  const prefix = scope.prefix;
  // A named production project lists only volumes labelled as its own, not every prefix
  // match. Development matches the prefix, so it also shows unlabelled volumes `remove` refuses.
  const labelFilter = config.production && config.name ? ['--filter', `label=${PROJECT_LABEL}=${scope.owner}`] : [];
  const output = await dockerOrThrow(['volume', 'ls', ...labelFilter, '--format', '{{.Name}}\t{{.Driver}}']);
  const sizes = await volumeSizes();
  const volumes: ProjectVolume[] = [];

  for (const line of output.split('\n')) {
    const [fullName, driver] = line.trim().split('\t');
    if (!fullName) continue;
    const parsed = parseProjectVolumeName(config, fullName);
    if (!parsed) continue;

    volumes.push({
      fullName,
      name: parsed.name,
      volumeSet: parsed.volumeSet,
      driver,
      size: sizes.get(fullName),
      usedBy: await containersUsing(fullName, true),
      services: declaredServicesFor(config, parsed.name),
      exists: true,
    });
  }

  for (const declared of config.volumes) {
    const fullName = volumeFullName(volumeScope(config).prefix, declared.name, config.volumeSet);
    if (volumes.some((volume) => volume.fullName === fullName)) continue;

    volumes.push({
      fullName,
      name: declared.name,
      volumeSet: config.volumeSet,
      usedBy: [],
      services: declared.services,
      exists: false,
    });
  }

  return volumes.sort(
    (left, right) => left.name.localeCompare(right.name) || (left.volumeSet ?? '').localeCompare(right.volumeSet ?? ''),
  );
}

async function volumeExists(fullName: string): Promise<boolean> {
  const result = await runDocker(['volume', 'inspect', fullName]);
  return result.code === 0;
}

/**
 * Copies a volume into a new `--<set>` variant. Refuses a source a running
 * container mounts unless `force`. Rolls back the target if the copy fails.
 */
export async function forkVolume(config: PortlerConfig, volumeArg: string, rawNewSet: string, force = false): Promise<ForkResult> {
  await ensureDockerRunning();

  const newSet = normalizeVolumeSet(rawNewSet);
  if (!newSet) throw new Error('fork requires a new volume set name, e.g. "portler volumes fork postgres-data migration"');

  const source = resolveVolumeName(config, volumeArg);
  const parsed = parseProjectVolumeName(config, source)!;
  const target = volumeFullName(volumeScope(config).prefix, parsed.name, newSet);

  if (target === source) throw new Error(`volume "${volumeArg}" already is the "${newSet}" variant`);
  if (!(await volumeExists(source))) {
    throw new Error(`volume not found: ${source}. Run "portler volumes" to see this project's volumes.`);
  }
  if ((await volumeOwnership(source, volumeScope(config).owner)) !== 'owned') {
    throw new Error(
      `source volume ${source} is not labelled as this project's (${PROJECT_LABEL}=${volumeScope(config).owner}); refusing to read or copy it`,
    );
  }
  if (await volumeExists(target)) {
    throw new Error(`target volume already exists: ${target}. Remove it first with "portler volumes remove ${parsed.name}${VOLUME_SET_SEPARATOR}${newSet}"`);
  }

  // A file copy of a running database's volume can be silently broken.
  const users = await containersUsing(source);
  if (users.length > 0 && !force) {
    throw new Error(
      `volume ${source} is in use by ${users.join(', ')}, and a copy of a running database can be broken. ` +
        'Stop the services that use it (portler down) or pass --force to copy it anyway.',
    );
  }
  if (users.length > 0) {
    process.stderr.write(`[portler] warning: volume ${source} is mounted by ${users.join(', ')}; the copy may be inconsistent.\n`);
  }

  const owner = volumeScope(config).owner;
  const attempt = randomUUID();
  const created = await runDocker([
    'volume',
    'create',
    ...volumeLabelArgs(owner, parsed.name, newSet),
    '--label',
    `${FORK_ATTEMPT_LABEL}=${attempt}`,
    target,
  ]);

  // A failed inspect counts as not ours.
  const createdByThisAttempt = async (): Promise<boolean> => {
    const labels = await volumeLabels(target).catch(() => null);
    return labels !== null && ownershipVerdict(labels, owner) === 'owned' && labels[FORK_ATTEMPT_LABEL] === attempt;
  };
  // Re-check right before removing: the name can be recreated between Docker calls,
  // and a concurrent fork's target carries the project label too.
  const rollback = async (): Promise<void> => {
    if (await createdByThisAttempt()) await runDocker(['volume', 'rm', target]);
  };

  // `docker volume create` succeeds for an existing volume and keeps its labels, so a
  // volume that won the race (foreign or another fork's) is never copied into or rolled back.
  const labels = await volumeLabels(target);
  if (labels !== null && ownershipVerdict(labels, owner) !== 'owned') {
    throw new Error(`target volume ${target} appeared during creation but is not owned by this project; refusing to overwrite it`);
  }
  if (labels !== null && labels[FORK_ATTEMPT_LABEL] !== attempt) {
    throw new Error(
      `another fork created target volume ${target} at the same time; refusing to copy into it. ` +
        `Check it with "portler volumes" once that fork has finished.`,
    );
  }
  if (created.code !== 0) {
    await rollback();
    const detail = created.stderr.trim() || created.stdout.trim() || `exit code ${created.code}`;
    throw new Error(`"docker volume create" failed: ${detail}`);
  }
  if (labels === null) throw new Error(`target volume ${target} disappeared right after it was created; refusing to continue`);

  try {
    await dockerOrThrow([
      'run',
      '--rm',
      '-v',
      `${source}:/from:ro`,
      '-v',
      `${target}:/to`,
      COPY_IMAGE,
      'sh',
      '-c',
      'cd /from && cp -a . /to',
    ]);
  } catch (error) {
    await rollback();
    throw new Error(`copying volume data failed: ${(error as Error).message}`);
  }

  return { source, target, volumeSet: newSet };
}

/** Decided by the project label; a volume's name alone is not proof of ownership. */
export async function volumeOwnership(fullName: string, volumeRoot: string): Promise<OwnershipVerdict> {
  const labels = await volumeLabels(fullName);
  return labels === null ? 'absent' : ownershipVerdict(labels, volumeRoot);
}

/** A volume's labels (empty when unlabelled), or null when it does not exist. */
async function volumeLabels(fullName: string): Promise<Record<string, string> | null> {
  const result = await runDocker(['volume', 'inspect', '--format', '{{json .Labels}}', fullName]);
  if (result.code !== 0) {
    if (/no such volume|not found/i.test(result.stderr)) return null;
    throw new Error(
      `could not determine ownership of Docker volume ${fullName}: ` +
        (result.stderr.trim().split('\n')[0] || `docker volume inspect exited ${result.code}`),
    );
  }

  return parseInspectLabels(result.stdout);
}

/** Remove a project volume, refusing while a running container mounts it unless forced. */
export async function removeVolume(config: PortlerConfig, volumeArg: string, force: boolean): Promise<string> {
  await ensureDockerRunning();

  const fullName = resolveVolumeName(config, volumeArg);
  if (!(await volumeExists(fullName))) {
    throw new Error(`volume not found: ${fullName}. Run "portler volumes" to see this project's volumes.`);
  }

  // Deleting destroys data for good, so require the label even with --force, which
  // skips only the in-use check. Older Portler versions left unlabelled volumes under managed names.
  if ((await volumeOwnership(fullName, volumeScope(config).owner)) !== 'owned') {
    throw new Error(
      `volume ${fullName} is not labelled as this project's (${PROJECT_LABEL}=${volumeScope(config).owner}), so Portler ` +
        'cannot confirm it created it and will not delete it, even with --force. Inspect it with "docker volume inspect ' +
        `${fullName}"; if it is a legacy volume you intend to discard, remove it manually with "docker volume rm ${fullName}".`,
    );
  }

  const users = await containersUsing(fullName);
  if (users.length > 0 && !force) {
    throw new Error(`volume ${fullName} is in use by ${users.join(', ')}. Stop the services (portler down) or pass --force.`);
  }

  // The volume can be recreated during the in-use query, so re-check right before removing.
  if ((await volumeOwnership(fullName, volumeScope(config).owner)) !== 'owned') {
    throw new Error(
      `ownership of volume ${fullName} changed while preparing to remove it; refusing to delete it. ` +
        `Inspect it with "docker volume inspect ${fullName}" and remove it manually only if you can confirm it is safe.`,
    );
  }

  await dockerOrThrow(['volume', 'rm', ...(force ? ['-f'] : []), fullName]);
  return fullName;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }

  return previous[right.length]!;
}

function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(input.length / 4)) + 1;

  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

/** Managed `@name` volumes the given services would create, per the active run mode. */
function managedVolumesFor(config: PortlerConfig, serviceNames: readonly string[]): string[] {
  const names = new Set<string>();

  for (const serviceName of serviceNames) {
    for (const volumeEntry of config.services[serviceName]?.docker?.volumes ?? []) {
      const rawName = managedVolumeName(volumeEntry);
      if (rawName !== undefined) names.add(normalizeVolumeToken(rawName, `volume name in "${volumeEntry}"`));
    }
  }

  return [...names].sort();
}

/** Managed volumes the services would create in the active set. `undefined` when Docker cannot be asked. */
export async function missingManagedVolumes(config: PortlerConfig, serviceNames: readonly string[]): Promise<string[] | undefined> {
  const managed = managedVolumesFor(config, serviceNames);
  if (managed.length === 0) return [];
  const result = await runDocker(['volume', 'ls', '--format', '{{.Name}}']);
  if (result.code !== 0) return undefined;
  const existing = new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
  return managed.filter((name) => !existing.has(volumeFullName(volumeScope(config).prefix, name, config.volumeSet)));
}

/**
 * A mistyped `--volume-set` creates an empty variant, which looks like data loss.
 * Warns when the variant is missing but the base or other sets exist; never throws
 * on Docker errors, which surface when the services start.
 */
export async function warnMissingVolumeSetVariants(config: PortlerConfig, serviceNames: readonly string[]): Promise<void> {
  if (!config.volumeSet) return;

  const managed = managedVolumesFor(config, serviceNames);
  if (managed.length === 0) return;

  const result = await runDocker(['volume', 'ls', '--format', '{{.Name}}']);
  if (result.code !== 0) return;
  const existing = new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));

  for (const name of managed) {
    if (existing.has(volumeFullName(volumeScope(config).prefix, name, config.volumeSet))) continue;

    const otherSets = [...existing]
      .map((fullName) => parseProjectVolumeName(config, fullName))
      .filter((parsed) => parsed?.name === name && parsed.volumeSet !== undefined)
      .map((parsed) => parsed!.volumeSet!)
      .sort();
    const hasBase = existing.has(volumeFullName(volumeScope(config).prefix, name));
    if (otherSets.length === 0 && !hasBase) continue; // brand-new volume: empty is expected

    const suggestion = didYouMean(config.volumeSet, otherSets);
    process.stderr.write(
      `[portler] warning: volume set "${config.volumeSet}" does not exist for "${name}" — creating a new EMPTY volume. ` +
        `Existing sets: ${[...otherSets, ...(hasBase ? ['base'] : [])].join(', ')}.` +
        (suggestion ? ` Did you mean "${suggestion}"?` : '') +
        ` Fork one first with "portler volumes fork" if you wanted its data.\n`,
    );
  }
}
