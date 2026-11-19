import path from 'node:path';
import { fnv1aBase36 } from '../util/hash.ts';
import type { PortlerConfig } from '../types/index.ts';

export function slug(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return value || 'project';
}

// The hash keeps projects with the same directory name apart.
function defaultDockerName(projectDir: string, name: string): string {
  return `portler-${slug(path.basename(projectDir))}-${fnv1aBase36(projectDir)}-${slug(name)}`;
}

export function defaultDockerImage(projectDir: string, serviceName: string): string {
  return defaultDockerName(projectDir, serviceName);
}

export function defaultDockerContainer(projectDir: string, serviceName: string): string {
  return defaultDockerName(projectDir, serviceName);
}

export function defaultDockerNetwork(projectDir: string): string {
  return `portler-${slug(path.basename(projectDir))}-${fnv1aBase36(projectDir)}`;
}

/**
 * Ends the project name in a named container or volume. `name:` never contains it or ends in "-", so `foo` + `bar-api`
 * and `foo-bar` + `api` differ, and no volume prefix overlaps another.
 */
export const PROJECT_NAME_BOUNDARY = '--';

/** Under --prod with `name:`, so containers and the network keep their names in any release folder; images stay hashed. */
export function namedDockerContainer(name: string, serviceName: string): string {
  return `portler-${name}${PROJECT_NAME_BOUNDARY}${slug(serviceName)}`;
}

export function namedDockerNetwork(name: string): string {
  return `portler-${name}`;
}

/** Before the volume set suffix. Volume and set names must not contain it, so names parse. */
export const VOLUME_SET_SEPARATOR = '--';

/** Hashes volumeRoot, not projectDir, so git worktrees of one repository share volumes; other objects stay per directory. */
export function projectVolumePrefix(volumeRoot: string): string {
  return `portler-${slug(path.basename(volumeRoot))}-${fnv1aBase36(volumeRoot)}-`;
}

/** `portler-<project>-<hash>-<name>`, plus `--<set>` for a volume set. */
export function projectVolumeName(volumeRoot: string, volumeName: string, volumeSet?: string): string {
  return volumeFullName(projectVolumePrefix(volumeRoot), volumeName, volumeSet);
}

/** Full Docker volume name for an `@name` volume under a prefix from volumeScope. */
export function volumeFullName(prefix: string, volumeName: string, volumeSet?: string): string {
  const base = `${prefix}${slug(volumeName)}`;
  return volumeSet ? `${base}${VOLUME_SET_SEPARATOR}${slug(volumeSet)}` : base;
}

/** Prefix and owner label of a project's managed volumes. Under --prod `name:` scopes them, so a new release folder keeps them. */
export function volumeScope(config: Pick<PortlerConfig, 'volumeRoot' | 'name' | 'production'>): { prefix: string; owner: string } {
  if (config.production && config.name) return { prefix: `portler-${config.name}${PROJECT_NAME_BOUNDARY}`, owner: config.name };
  return { prefix: projectVolumePrefix(config.volumeRoot), owner: config.volumeRoot };
}

/** An RFC 1123 label, as Kubernetes requires. Throws when nothing is left. */
export function k8sName(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');

  if (!value) throw new Error(`cannot derive a Kubernetes name from "${input}"`);
  return value;
}

export function defaultK8sNamespace(projectDir: string): string {
  return k8sName(`portler-${slug(path.basename(projectDir))}-${fnv1aBase36(projectDir)}`);
}
