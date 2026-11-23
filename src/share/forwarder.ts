import net from 'node:net';
import { isObject, isPort, isString } from '../util/guards.ts';
import { normalizeIpAddress } from '../util/ip.ts';
import { sleep } from '../util/sleep.ts';
import { isTailnetAddress } from './tailnet.ts';

/** One service's share listeners: `addresses`:`port` piped to the service on `upstream`:`port`. */
export interface ShareForwardSpec {
  service: string;
  port: number;
  /** The service's own bind host. */
  upstream: string;
  addresses: string[];
  tailnetOnly: boolean;
}

export function isShareForwardSpec(value: unknown): value is ShareForwardSpec {
  return (
    isObject(value) &&
    isString(value.service) &&
    isPort(value.port) &&
    isString(value.upstream) &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined) &&
    typeof value.tailnetOnly === 'boolean'
  );
}

const UPSTREAM_POLL_MS = 300;
const BIND_RETRY_MS = 2_000;

/** The hosts to try for a service bound to `host`; `localhost` may be either loopback family. */
export function upstreamHosts(host: string): string[] {
  if (host === 'localhost' || host === '127.0.0.1') return ['127.0.0.1', '::1'];
  return [host];
}

function log(spec: ShareForwardSpec, message: string): void {
  process.stderr.write(`[portler share] ${spec.service}: ${message}\n`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function firstReachable(hosts: readonly string[], port: number): Promise<string | undefined> {
  for (const host of hosts) {
    if (await canConnect(host, port)) return host;
  }
  return undefined;
}

// Connects from the shared address when the OS allows it, so the service does not see a remote peer as loopback.
function connectUpstream(host: string, port: number, localAddress: string | undefined): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, ...(localAddress !== undefined ? { localAddress } : {}) });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function sameFamily(a: string, b: string): boolean {
  return net.isIPv4(a) === net.isIPv4(b);
}

function pipe(client: net.Socket, upstream: net.Socket): void {
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
}

export interface ShareForwarder {
  close: () => Promise<void>;
}

/**
 * Listens once the service accepts connections, so the forwarder never takes a port the service is about to bind.
 * A service already bound to every interface owns the shared address too (Linux refuses the second bind): warn and stop.
 */
export function startShareForwarder(spec: ShareForwardSpec, signal?: AbortSignal): ShareForwarder {
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  let closed = false;
  let localSourceWorks = true;

  const handle = async (client: net.Socket, listenAddress: string, upstreamHost: string): Promise<void> => {
    client.pause();
    // A peer can reset while the upstream connection is still being made.
    client.on('error', () => client.destroy());
    const peer = client.remoteAddress ?? '';
    if (spec.tailnetOnly && !isTailnetAddress(peer)) {
      client.destroy();
      return;
    }
    let upstream: net.Socket;
    const source = localSourceWorks ? [listenAddress, ...spec.addresses].find((address) => sameFamily(address, upstreamHost)) : undefined;
    try {
      upstream = await connectUpstream(upstreamHost, spec.port, source);
    } catch (error) {
      if (source === undefined) {
        client.destroy();
        return;
      }
      // macOS refuses a loopback connection from a non-loopback source address.
      localSourceWorks = false;
      log(spec, `cannot connect from ${source} (${(error as Error).message}); the service sees shared connections as local`);
      try {
        upstream = await connectUpstream(upstreamHost, spec.port, undefined);
      } catch {
        client.destroy();
        return;
      }
    }
    if (closed) {
      client.destroy();
      upstream.destroy();
      return;
    }
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    pipe(client, upstream);
    client.resume();
  };

  const listen = (address: string, upstreamHost: string): Promise<'ok' | 'taken' | 'retry'> =>
    new Promise((resolve) => {
      const server = net.createServer({ allowHalfOpen: false }, (client) => {
        void handle(client, address, upstreamHost);
      });
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.close();
        resolve(error.code === 'EADDRINUSE' ? 'taken' : 'retry');
      });
      server.listen({ host: address, port: spec.port, exclusive: true }, () => {
        servers.push(server);
        resolve('ok');
      });
    });

  const run = async (): Promise<void> => {
    let upstreamHost: string | undefined;
    while (!closed && upstreamHost === undefined) {
      upstreamHost = await firstReachable(upstreamHosts(spec.upstream), spec.port);
      if (upstreamHost === undefined) await sleep(UPSTREAM_POLL_MS);
    }
    for (const address of spec.addresses) {
      let warned = false;
      while (!closed) {
        const result = await listen(address, upstreamHost!);
        if (closed) break;
        if (result === 'ok') {
          log(spec, `shared on ${address.includes(':') ? `[${address}]` : address}:${spec.port}`);
          break;
        }
        if (result === 'taken') {
          log(
            spec,
            `${address}:${spec.port} is already in use. If the service listens on all interfaces (0.0.0.0 or ::), ` +
              'it is reachable from every network, not only the shared one; make it listen on 127.0.0.1.',
          );
          break;
        }
        // The address can be missing for a while, e.g. while tailscaled restarts.
        if (!warned) log(spec, `cannot listen on ${address} yet; retrying`);
        warned = true;
        await sleep(BIND_RETRY_MS);
      }
    }
  };

  const close = async (): Promise<void> => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  signal?.addEventListener('abort', () => void close(), { once: true });
  void run();
  return { close };
}
