import { fileURLToPath } from 'node:url';
import { shellQuote } from '../process/docker.ts';
import { typeStrippingArgs } from '../proxy/spawn.ts';
import { sharesPort } from './settings.ts';
import type { PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';
import type { ShareForwardSpec } from './forwarder.ts';

export function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]' || host === '';
}

/** Undefined when the run is not shared, the service keeps its port local, or it already binds every interface. */
export function shareForwardSpec(
  config: PortlerConfig,
  service: ServiceConfig,
  assignment: ServiceAssignment | undefined,
): ShareForwardSpec | undefined {
  const share = config.share;
  if (!share || !assignment || !sharesPort(service) || isWildcardHost(assignment.host)) return undefined;
  return { service: service.name, port: assignment.port, upstream: assignment.host, addresses: share.addresses, tailnetOnly: share.tailnetOnly };
}

function daemonPath(): string {
  const daemonFile = import.meta.url.endsWith('.ts') ? './daemon.ts' : './daemon.js';
  return fileURLToPath(new URL(daemonFile, import.meta.url));
}

/** A shell line that starts the forwarder in the background of the service's own shell, so the forwarder is in the
 * service's process group: whatever stops the service stops it too. */
export function shareForwarderShellLine(spec: ShareForwardSpec): string {
  return `${[process.execPath, ...typeStrippingArgs(), daemonPath(), JSON.stringify(spec)].map(shellQuote).join(' ')} &\n`;
}
