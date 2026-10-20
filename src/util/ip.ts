import net from 'node:net';

/** Exact IP identity, including equivalent IPv6 spellings and mapped IPv4 peers. */
export function normalizeIpAddress(value: string): string | undefined {
  // Scope identifiers are interface-dependent, not portable exact IP identities.
  if (value.includes('%') || net.isIP(value) === 0) return undefined;
  if (net.isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16);
  const low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
