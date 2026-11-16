import { createHash } from 'node:crypto';

export function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * For short, stable generated names only. A collision only shares a name, since
 * deletes check the ownership label; use projectHash for anything that decides ownership.
 */
export function fnv1aBase36(input: string): string {
  return fnv1a(input).toString(36);
}

/**
 * The project identity in ownership labels, which authorizes deletes, so it must
 * not collide: SHA-256, not 32-bit FNV-1a. 32 hex chars fit a Kubernetes label value (max 63).
 */
export function projectHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}
