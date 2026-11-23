import { PROXY_SERVICE_NAME } from '../constants.ts';
import { usesTcp } from '../ports/transport.ts';
import { isWildcardHost } from './command.ts';
import { sharesPort } from './settings.ts';
import type { Assignments, PortlerConfig } from '../types/index.ts';

/** Says exactly which ports other machines can reach, and which ones stay local. */
export function reportShare(config: PortlerConfig, serviceNames: readonly string[], assignments: Assignments): void {
  const share = config.share;
  if (!share) return;
  const shared: string[] = [];
  for (const name of serviceNames) {
    const service = config.services[name];
    const assignment = assignments[name];
    if (!service || !assignment || service.port === undefined) continue;
    if (!usesTcp(service)) {
      process.stderr.write(`[portler] warning: ${name} uses UDP only, which --share does not forward; it stays on this machine\n`);
    } else if (service.share === false) {
      process.stdout.write(`[portler] ${name}: not shared (share: false)\n`);
    } else if (isWildcardHost(assignment.host)) {
      process.stderr.write(
        `[portler] warning: ${name} listens on all interfaces (host: ${assignment.host}), so every network can reach it, not only --share ${share.target}\n`,
      );
    } else if (sharesPort(service)) {
      shared.push(`${name} ${assignment.port}`);
      if (service.transport === 'tcp+udp') process.stderr.write(`[portler] warning: ${name}: only its TCP port is shared\n`);
    }
  }
  if (config.proxy && assignments[PROXY_SERVICE_NAME] && serviceNames.includes(PROXY_SERVICE_NAME)) {
    shared.push(`${PROXY_SERVICE_NAME} ${assignments[PROXY_SERVICE_NAME].port}`);
  }
  if (shared.length === 0) return;
  const where = share.target.startsWith('tailscale') ? `tailscale (${share.addresses.join(', ')})` : share.target;
  const who = share.tailnetOnly ? 'every tailnet device your ACLs allow' : 'every machine on that network';
  process.stdout.write(`[portler] shared on ${where}, reachable by ${who}: ${shared.join(', ')}\n`);
}
