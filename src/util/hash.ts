import { createHash } from 'node:crypto';

/**
 * FNV-1a hash, used to derive stable-but-spread values from strings such as
 * project paths and service names.
 */
export function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * FNV-1a hash rendered as a short base36 string for use in identifiers.
 *
 * Cosmetic only: it keeps generated NAMES (containers, images, the default
 * namespace) short and stable. Two project paths colliding here means two
 * projects share a name — annoying, but every destructive action is gated on the
 * ownership LABEL, not on the name. Use projectHash for anything that decides
 * ownership.
 */
export function fnv1aBase36(input: string): string {
  return fnv1a(input).toString(36);
}

/**
 * The identity of a project, as stamped into ownership labels.
 *
 * This value is what authorizes `portler down k8s` to delete a namespace and its
 * Deployments, so a collision is not cosmetic: two project directories that hash
 * to the same value would each see the OTHER's resources as its own. FNV-1a is a
 * 32-bit non-cryptographic hash — a collision is findable by brute force in
 * seconds, and even by accident the birthday bound is only ~77k paths — so it is
 * not a sound basis for that decision. SHA-256 truncated to 128 bits is: it is
 * deterministic (the same path always yields the same label), collision-resistant,
 * and a valid Kubernetes label value (32 hex chars, well inside the 63-char limit
 * and the allowed alphabet).
 */
export function projectHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}
