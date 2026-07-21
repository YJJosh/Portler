import fs from 'node:fs/promises';
import path from 'node:path';
import { slug, VOLUME_SET_SEPARATOR } from './naming.ts';
import type { DeclaredVolume, DockerConfig, ServiceConfig } from '../types/index.ts';

/**
 * Extract the short name of a Portler-managed volume entry (`@name:/path`).
 * Returns undefined for bind mounts and plain Docker volume syntax.
 */
export function managedVolumeName(volumeEntry: string): string | undefined {
  if (!volumeEntry.startsWith('@')) return undefined;
  const parts = volumeEntry.split(':');
  if (parts.length < 2) return undefined;
  return parts[0]!.slice(1);
}

/**
 * Validate and normalize a short volume name or volume set name. Both become
 * segments of a Docker volume name, so they are slugged like every other
 * Portler-derived name and must not contain the `--` set separator.
 */
export function normalizeVolumeToken(raw: string, what: string): string {
  const trimmed = raw.trim();
  const value = slug(trimmed);
  if (!trimmed) throw new Error(`${what} must not be empty`);
  // slug() has a generic "project" fallback for cosmetic project names. A
  // managed data volume must not silently map an all-Unicode/unsupported token
  // to that unrelated name.
  if (!/[A-Za-z0-9]/.test(trimmed)) {
    throw new Error(`${what} "${raw}" must contain at least one ASCII letter or digit`);
  }
  if (value.includes(VOLUME_SET_SEPARATOR)) {
    throw new Error(`${what} "${raw}" must not contain "${VOLUME_SET_SEPARATOR}" (reserved for volume set variants)`);
  }
  return value;
}

/** Normalize the --volume-set flag / PORTLER_VOLUME_SET value (undefined when unset). */
export function normalizeVolumeSet(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return normalizeVolumeToken(raw, 'volume set');
}

/**
 * Collect every Portler-managed volume (`@name` source) declared across all
 * services, including their `docker:` mode overrides, and validate the names.
 */
export function collectDeclaredVolumes(services: Record<string, ServiceConfig>): DeclaredVolume[] {
  const servicesByVolume = new Map<string, Set<string>>();
  const rawNameByVolume = new Map<string, string>();

  const collect = (serviceName: string, docker: DockerConfig | undefined): void => {
    for (const volumeEntry of docker?.volumes ?? []) {
      const rawName = managedVolumeName(volumeEntry);
      if (rawName === undefined) continue;
      const name = normalizeVolumeToken(rawName, `services.${serviceName} volume name`);
      const priorRawName = rawNameByVolume.get(name);
      if (priorRawName !== undefined && priorRawName.trim() !== rawName.trim()) {
        throw new Error(
          `managed volume names "${priorRawName}" and "${rawName}" both normalize to "${name}"; rename one to avoid sharing data unintentionally`,
        );
      }
      rawNameByVolume.set(name, rawName);
      const users = servicesByVolume.get(name) ?? new Set<string>();
      users.add(serviceName);
      servicesByVolume.set(name, users);
    }
  };

  for (const [serviceName, service] of Object.entries(services)) {
    collect(serviceName, service.docker);
    collect(serviceName, service.dockerModeOverride);
  }

  return [...servicesByVolume.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, users]) => ({ name, services: [...users].sort() }));
}

/**
 * Directory that scopes Portler-managed volume names. Linked git worktrees
 * (where `.git` is a `gitdir: .../.git/worktrees/<name>` file) resolve to the
 * main repository root, so every worktree of a project shares its volumes and
 * can fork them per branch; anything else resolves to projectDir itself.
 */
export async function resolveVolumeRoot(projectDir: string): Promise<string> {
  try {
    const gitPath = path.join(projectDir, '.git');
    if (!(await fs.stat(gitPath)).isFile()) return projectDir;

    const match = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(gitPath, 'utf8'));
    if (!match) return projectDir;

    const gitDir = path.resolve(projectDir, match[1]!);
    const worktreeMatch = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(gitDir);
    return worktreeMatch ? worktreeMatch[1]! : projectDir;
  } catch {
    return projectDir;
  }
}

/** `docker volume create` label arguments that let Portler find its volumes later. */
export function volumeLabelArgs(volumeRoot: string, volumeName: string, volumeSet?: string): string[] {
  const args = ['--label', `portler.project=${volumeRoot}`, '--label', `portler.volume=${volumeName}`];
  if (volumeSet) args.push('--label', `portler.volume-set=${volumeSet}`);
  return args;
}
