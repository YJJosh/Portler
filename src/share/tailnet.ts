import net from 'node:net';
import { normalizeIpAddress } from '../util/ip.ts';

// The ranges Tailscale and Headscale hand out node addresses from.
const TAILNET = new net.BlockList();
TAILNET.addSubnet('100.64.0.0', 10, 'ipv4');
TAILNET.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');

export function isTailnetAddress(ip: string): boolean {
  const normalized = normalizeIpAddress(ip);
  if (normalized === undefined) return false;
  return TAILNET.check(normalized, net.isIPv4(normalized) ? 'ipv4' : 'ipv6');
}

