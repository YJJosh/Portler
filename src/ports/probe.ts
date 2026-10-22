import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import net from 'node:net';
import { transportProtocols } from './transport.ts';
import type { PortTransport } from '../types/index.ts';

function normalizeCheckHost(host: string): string {
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

function isTcpPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function isUdpPortFree(port: number, host: string): Promise<boolean> {
  // REVIEW: Pick the socket family from DNS, not the hostname's spelling; an
  // IPv6-only hostname otherwise gets an IPv4 socket and every port looks busy.
  let resolved;
  try {
    resolved = await dns.lookup(host);
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: resolved.family === 6 ? 'udp6' : 'udp4' });

    socket.unref();
    socket.on('error', () => {
      socket.close();
      resolve(false);
    });
    socket.bind({ port, address: resolved.address, exclusive: true }, () => {
      socket.close(() => resolve(true));
    });
  });
}

/**
 * Resolve to true when nothing is currently bound to the given host:port on
 * every protocol of `transport`. A `tcp+udp` port has to be free on both.
 */
export async function isPortFree(port: number, host = '127.0.0.1', transport: PortTransport = 'tcp'): Promise<boolean> {
  const checkHost = normalizeCheckHost(host);
  for (const protocol of transportProtocols(transport)) {
    const free = protocol === 'tcp' ? await isTcpPortFree(port, checkHost) : await isUdpPortFree(port, checkHost);
    if (!free) return false;
  }
  return true;
}
