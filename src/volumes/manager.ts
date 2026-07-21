import {
  managedVolumeName,
  normalizeVolumeSet,
  normalizeVolumeToken,
  projectVolumeName,
  projectVolumePrefix,
  VOLUME_SET_SEPARATOR,
  volumeLabelArgs,
} from '../config/index.ts';
import { ownershipVerdict, parseInspectLabels, PROJECT_LABEL } from '../process/ownership.ts';
import type { OwnershipVerdict } from '../process/ownership.ts';
import { dockerOrThrow, ensureDockerRunning, runDocker } from './docker.ts';
import type { PortlerConfig } from '../types/index.ts';

/** Image used to copy data between volumes when forking. */
const COPY_IMAGE = 'alpine:3';

export interface ProjectVolume {
  /** Full Docker volume name. */
  fullName: string;
  /** Short name as declared in portler.yml. */
  name: string;
  /** Volume set variant, if any. */
  volumeSet?: string;
  driver?: string;
  /** Human-readable size from `docker system df -v`, when available. */
  size?: string;
  /** Names of running containers currently mounting the volume. */
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

/** Split a full project volume name back into short name + volume set. */
export function parseProjectVolumeName(
  config: PortlerConfig,
  fullName: string,
): { name: string; volumeSet?: string } | undefined {
  const prefix = projectVolumePrefix(config.volumeRoot);
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
  const prefix = projectVolumePrefix(config.volumeRoot);
  if (volumeArg.startsWith(prefix)) return volumeArg;
  if (volumeArg.startsWith('portler-')) {
    throw new Error(`volume "${volumeArg}" does not belong to this project (expected prefix "${prefix}")`);
  }

  const short = volumeArg.startsWith('@') ? volumeArg.slice(1) : volumeArg;
  const separatorIndex = short.indexOf(VOLUME_SET_SEPARATOR);

  if (separatorIndex === -1) {
    return projectVolumeName(config.volumeRoot, normalizeVolumeToken(short, 'volume name'), config.volumeSet);
  }

  const name = normalizeVolumeToken(short.slice(0, separatorIndex), 'volume name');
  const volumeSet = normalizeVolumeSet(short.slice(separatorIndex + VOLUME_SET_SEPARATOR.length));
  return projectVolumeName(config.volumeRoot, name, volumeSet);
}

function declaredServicesFor(config: PortlerConfig, volumeName: string): string[] {
  return config.volumes.find((volume) => volume.name === volumeName)?.services ?? [];
}

/** Best-effort map of volume name -> human-readable size via `docker system df -v`. */
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

/** Names of running containers mounting the volume (best effort). */
async function containersUsing(fullName: string): Promise<string[]> {
  const result = await runDocker(['ps', '--filter', `volume=${fullName}`, '--format', '{{.Names}}']);
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * List this project's Portler-managed volumes: every existing Docker volume
 * with the project's name prefix, plus volumes declared in portler.yml that
 * Docker has not created yet (exists: false).
 */
export async function listProjectVolumes(config: PortlerConfig): Promise<ProjectVolume[]> {
  await ensureDockerRunning();

  const prefix = projectVolumePrefix(config.volumeRoot);
  const output = await dockerOrThrow(['volume', 'ls', '--format', '{{.Name}}\t{{.Driver}}']);
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
      usedBy: await containersUsing(fullName),
      services: declaredServicesFor(config, parsed.name),
      exists: true,
    });
  }

  for (const declared of config.volumes) {
    const fullName = projectVolumeName(config.volumeRoot, declared.name, config.volumeSet);
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
 * Clone a volume's data into a new `--<set>` variant so a branch or worktree
 * can experiment (e.g. test a migration) without touching the original.
 */
export async function forkVolume(config: PortlerConfig, volumeArg: string, rawNewSet: string): Promise<ForkResult> {
  await ensureDockerRunning();

  const newSet = normalizeVolumeSet(rawNewSet);
  if (!newSet) throw new Error('fork requires a new volume set name, e.g. "portler volumes fork postgres-data migration"');

  const source = resolveVolumeName(config, volumeArg);
  const parsed = parseProjectVolumeName(config, source)!;
  const target = projectVolumeName(config.volumeRoot, parsed.name, newSet);

  if (target === source) throw new Error(`volume "${volumeArg}" already is the "${newSet}" variant`);
  if (!(await volumeExists(source))) {
    throw new Error(`volume not found: ${source}. Run "portler volumes" to see this project's volumes.`);
  }
  if ((await volumeOwnership(source, config.volumeRoot)) !== 'owned') {
    throw new Error(
      `source volume ${source} is not labelled as this project's (${PROJECT_LABEL}=${config.volumeRoot}); refusing to read or copy it`,
    );
  }
  if (await volumeExists(target)) {
    throw new Error(`target volume already exists: ${target}. Remove it first with "portler volumes remove ${parsed.name}${VOLUME_SET_SEPARATOR}${newSet}"`);
  }

  const users = await containersUsing(source);
  if (users.length > 0) {
    process.stderr.write(
      `[portler] warning: volume ${source} is mounted by ${users.join(', ')}; the copy may be inconsistent. Consider "portler down" first.\n`,
    );
  }

  await dockerOrThrow(['volume', 'create', ...volumeLabelArgs(config.volumeRoot, parsed.name, newSet), target]);

  // `docker volume create` returns success for an existing volume. Re-check after
  // creation so a foreign volume that won the exists/create race is never used as
  // the copy target (and never removed by our rollback).
  if ((await volumeOwnership(target, config.volumeRoot)) !== 'owned') {
    throw new Error(`target volume ${target} appeared during creation but is not owned by this project; refusing to overwrite it`);
  }

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
    // Fail closed on the cleanup too: only remove a target that is STILL ours.
    // A name can be deleted/recreated between Docker calls.
    if ((await volumeOwnership(target, config.volumeRoot).catch(() => 'absent' as const)) === 'owned') {
      await runDocker(['volume', 'rm', target]);
    }
    throw new Error(`copying volume data failed: ${(error as Error).message}`);
  }

  return { source, target, volumeSet: newSet };
}

/**
 * Whether a volume carries this project's label. The name alone is not proof of
 * ownership, and this is the one Portler operation that destroys data
 * irreversibly — so it is checked separately.
 */
export async function volumeOwnership(fullName: string, volumeRoot: string): Promise<OwnershipVerdict> {
  const result = await runDocker(['volume', 'inspect', '--format', '{{json .Labels}}', fullName]);
  if (result.code !== 0) {
    if (/no such volume|not found/i.test(result.stderr)) return 'absent';
    throw new Error(
      `could not determine ownership of Docker volume ${fullName}: ` +
        (result.stderr.trim().split('\n')[0] || `docker volume inspect exited ${result.code}`),
    );
  }

  return ownershipVerdict(parseInspectLabels(result.stdout), volumeRoot);
}

/** Remove a project volume, refusing while a running container mounts it unless forced. */
export async function removeVolume(config: PortlerConfig, volumeArg: string, force: boolean): Promise<string> {
  await ensureDockerRunning();

  const fullName = resolveVolumeName(config, volumeArg);
  if (!(await volumeExists(fullName))) {
    throw new Error(`volume not found: ${fullName}. Run "portler volumes" to see this project's volumes.`);
  }

  // Deleting a volume destroys its data for good, so require proof it is ours.
  // --force may bypass the separate in-use guard below, but it must never turn
  // an expected name into proof of ownership. In particular, legacy Portler
  // versions could leave unlabelled volumes under a convincing managed name.
  if ((await volumeOwnership(fullName, config.volumeRoot)) !== 'owned') {
    throw new Error(
      `volume ${fullName} is not labelled as this project's (${PROJECT_LABEL}=${config.volumeRoot}), so Portler ` +
        'cannot confirm it created it and will not delete it, even with --force. Inspect it with "docker volume inspect ' +
        `${fullName}"; if it is a legacy volume you intend to discard, remove it manually with "docker volume rm ${fullName}".`,
    );
  }

  const users = await containersUsing(fullName);
  if (users.length > 0 && !force) {
    throw new Error(`volume ${fullName} is in use by ${users.join(', ')}. Stop the services (portler down) or pass --force.`);
  }

  // The in-use query is another Docker round trip during which a named volume
  // can be removed and recreated. Re-check at the destructive boundary so a
  // foreign replacement is refused rather than removed under the old verdict.
  if ((await volumeOwnership(fullName, config.volumeRoot)) !== 'owned') {
    throw new Error(
      `ownership of volume ${fullName} changed while preparing to remove it; refusing to delete it. ` +
        `Inspect it with "docker volume inspect ${fullName}" and remove it manually only if you can confirm it is safe.`,
    );
  }

  await dockerOrThrow(['volume', 'rm', ...(force ? ['-f'] : []), fullName]);
  return fullName;
}

/** Classic two-row Levenshtein edit distance, used for did-you-mean hints. */
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

/** Closest candidate within a small edit distance, or undefined when nothing is close. */
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

/**
 * Guard against typos in `up --volume-set` / PORTLER_VOLUME_SET: starting with
 * a set that was never forked silently creates a fresh EMPTY variant, which
 * looks like data loss. For each managed volume the selected services are
 * about to create, warn when the requested set variant does not exist but the
 * base volume or other set variants do (with a did-you-mean when a set name is
 * close). Best effort: Docker errors are ignored here and surface when the
 * services actually start. The volume is still created — warning, not error.
 */
export async function warnMissingVolumeSetVariants(config: PortlerConfig, serviceNames: readonly string[]): Promise<void> {
  if (!config.volumeSet) return;

  const managed = managedVolumesFor(config, serviceNames);
  if (managed.length === 0) return;

  const result = await runDocker(['volume', 'ls', '--format', '{{.Name}}']);
  if (result.code !== 0) return;
  const existing = new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));

  for (const name of managed) {
    if (existing.has(projectVolumeName(config.volumeRoot, name, config.volumeSet))) continue;

    const otherSets = [...existing]
      .map((fullName) => parseProjectVolumeName(config, fullName))
      .filter((parsed) => parsed?.name === name && parsed.volumeSet !== undefined)
      .map((parsed) => parsed!.volumeSet!)
      .sort();
    const hasBase = existing.has(projectVolumeName(config.volumeRoot, name));
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
