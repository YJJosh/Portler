import net from 'node:net';

/** Canonical form, so IPv6 spellings and IPv4-mapped peers compare equal; undefined for a non-IP. */
export function normalizeIpAddress(value: string): string | undefined {
  // A scope id (`%eth0`) depends on the interface, so it has no exact identity.
  if (value.includes('%') || net.isIP(value) === 0) return undefined;
  if (net.isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
