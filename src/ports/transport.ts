import type { PortTransport, ServiceConfig } from '../types/index.ts';

export type IpProtocol = 'tcp' | 'udp';

export const PORT_TRANSPORTS: readonly PortTransport[] = ['tcp', 'udp', 'tcp+udp'];

export function isPortTransport(value: unknown): value is PortTransport {
  return typeof value === 'string' && (PORT_TRANSPORTS as readonly string[]).includes(value);
}

/** A service's transport; a ServiceConfig built without one is plain TCP. */
export function serviceTransport(service: Pick<ServiceConfig, 'transport'>): PortTransport {
  return service.transport ?? 'tcp';
}

/** The IP protocols a transport binds, in the order Portler probes and publishes them. */
export function transportProtocols(transport: PortTransport): IpProtocol[] {
  if (transport === 'tcp+udp') return ['tcp', 'udp'];
  return [transport];
}

export function usesTcp(service: Pick<ServiceConfig, 'transport'>): boolean {
  return serviceTransport(service) !== 'udp';
}
