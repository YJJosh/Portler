import { fileURLToPath } from 'node:url';
import { typeStrippingArgs } from '../proxy/spawn.ts';
import { sharesPort } from './settings.ts';
import { normalizeIpAddress } from '../util/ip.ts';
import { isWildcardHost } from './tailnet.ts';
import type { EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';
import { SERVICE_NODE_OPTIONS, type ShareForwardSpec } from './forwarder.ts';

/** Undefined when the run is not shared, the service keeps its port local, or it already binds every interface. */
export function shareForwardSpec(
  config: PortlerConfig,
  service: ServiceConfig,
  assignment: ServiceAssignment | undefined,
): ShareForwardSpec | undefined {
  const share = config.share;
  if (!share || !assignment || !sharesPort(service) || isWildcardHost(assignment.host)) return undefined;
  // A service bound to a shared address itself needs no forwarder there.
  const host = normalizeIpAddress(assignment.host.replace(/^\[|\]$/g, ''));
  const addresses = share.addresses.filter((address) => address !== host);
  if (addresses.length === 0) return undefined;
  return { service: service.name, port: assignment.port, upstream: assignment.host, addresses, tailnetOnly: share.tailnetOnly };
}

function daemonPath(): string {
  const daemonFile = import.meta.url.endsWith('.ts') ? './daemon.ts' : './daemon.js';
  return fileURLToPath(new URL(daemonFile, import.meta.url));
}

/** How to start a shared service: a Portler wrapper that leads the process group, runs `command` in a shell as its
 * child and listens on the shared addresses until the shell exits. Whatever stops the service stops the forwarder. */
export function shareWrapperSpawn(spec: ShareForwardSpec, command: string, env: EnvMap): { file: string; args: string[]; env: EnvMap } {
  const wrapperEnv: EnvMap = { ...env };
  delete wrapperEnv.NODE_OPTIONS;
  if (env.NODE_OPTIONS !== undefined) wrapperEnv[SERVICE_NODE_OPTIONS] = env.NODE_OPTIONS;
  return { file: process.execPath, args: [...typeStrippingArgs(), daemonPath(), JSON.stringify(spec), command], env: wrapperEnv };
}
