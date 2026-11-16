import type { PortTransport, ServiceConfig } from '../types/index.ts';

export type IpProtocol = 'tcp' | 'udp';

export const PORT_TRANSPORTS: readonly PortTransport[] = ['tcp', 'udp', 'tcp+udp'];

export function isPortTransport(value: unknown): value is PortTransport {
  return typeof value === 'string' && (PORT_TRANSPORTS as readonly string[]).includes(value);
}

export function serviceTransport(service: Pick<ServiceConfig, 'transport'>): PortTransport {
  return service.transport ?? 'tcp';
}

/** In the order Portler probes and publishes them. */
export function transportProtocols(transport: PortTransport): IpProtocol[] {
  if (transport === 'tcp+udp') return ['tcp', 'udp'];
  return [transport];
}

export function usesTcp(service: Pick<ServiceConfig, 'transport'>): boolean {
  return serviceTransport(service) !== 'udp';
}
