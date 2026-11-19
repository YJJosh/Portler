import { createHash } from 'node:crypto';

export function fnv1a(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** For short generated names only: deletes check the ownership label, so a collision just shares a name.
 * Anything that decides ownership uses projectHash. */
export function fnv1aBase36(input: string): string {
  return fnv1a(input).toString(36);
}

/** Project identity in ownership labels, which authorize deletes, so SHA-256, not 32-bit FNV-1a.
 * 32 hex chars fit a Kubernetes label value (max 63). */
export function projectHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
}
