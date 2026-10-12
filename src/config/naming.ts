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

// Images and containers deliberately share the same default name; the hash
// keeps names from colliding across projects with the same directory name.
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
 * Under --prod with a top-level `name:`, containers and the network carry the
 * name instead of the directory hash, so they are the same in every folder a
 * release unpacks into. Images keep the hashed default.
 */
export function namedDockerContainer(name: string, serviceName: string): string {
  return `portler-${name}-${slug(serviceName)}`;
}

export function namedDockerNetwork(name: string): string {
  return `portler-${name}`;
}

/**
 * Separates the volume set suffix from the base volume name. Managed volume
 * and set names must not contain it so the full name parses unambiguously.
 */
export const VOLUME_SET_SEPARATOR = '--';

/**
 * Prefix shared by every Portler-managed volume of a project. Volumes hash
 * volumeRoot (not projectDir) so git worktrees of the same repository see the
 * same volumes; containers/images/networks stay per-directory.
 */
export function projectVolumePrefix(volumeRoot: string): string {
  return `portler-${slug(path.basename(volumeRoot))}-${fnv1aBase36(volumeRoot)}-`;
}

/**
 * Full Docker volume name for an `@name` volume:
 * `portler-<project>-<hash>-<name>` plus `--<set>` for a volume set variant.
 */
export function projectVolumeName(volumeRoot: string, volumeName: string, volumeSet?: string): string {
  return volumeFullName(projectVolumePrefix(volumeRoot), volumeName, volumeSet);
}

/** Full Docker volume name for an `@name` volume under a prefix from volumeScope. */
export function volumeFullName(prefix: string, volumeName: string, volumeSet?: string): string {
  const base = `${prefix}${slug(volumeName)}`;
  return volumeSet ? `${base}${VOLUME_SET_SEPARATOR}${slug(volumeSet)}` : base;
}

/**
 * Where a project's managed volumes live and the owner they are labelled with.
 * Development scopes them by the hash of volumeRoot, so every checkout has its
 * own data. Under --prod with a `name:` the name scopes them instead, so a
 * release that unpacks into a new folder keeps its volumes; the owner label is
 * then the name, which never looks like a path.
 */
export function volumeScope(config: Pick<PortlerConfig, 'volumeRoot' | 'name' | 'production'>): { prefix: string; owner: string } {
  if (config.production && config.name) return { prefix: `portler-${config.name}-`, owner: config.name };
  return { prefix: projectVolumePrefix(config.volumeRoot), owner: config.volumeRoot };
}

/**
 * Sanitize a name for Kubernetes (RFC 1123 label): lowercase alphanumerics
 * and dashes, starting and ending with an alphanumeric.
 */
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

/** Project-scoped namespace so `portler down k8s` can clean everything up. */
export function defaultK8sNamespace(projectDir: string): string {
  return k8sName(`portler-${slug(path.basename(projectDir))}-${fnv1aBase36(projectDir)}`);
}
