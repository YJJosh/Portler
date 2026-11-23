import net from 'node:net';
import { isObject, isPort, isString } from '../util/guards.ts';
import { normalizeIpAddress } from '../util/ip.ts';
import { setTimeout as delay } from 'node:timers/promises';
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

/** The service's own NODE_OPTIONS, moved aside so they apply to the service and not to the wrapper's Node. */
export const SERVICE_NODE_OPTIONS = 'PORTLER_SHARE_SERVICE_NODE_OPTIONS';

const UPSTREAM_POLL_MS = 300;
const BIND_RETRY_MS = 2_000;

/** The hosts to try for a service bound to `host`; `localhost` may be either loopback family. */
export function upstreamHosts(host: string): string[] {
  return host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
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

const CONNECT_TIMEOUT_MS = 5_000;
// The errors a service that is down for a moment gives; they say nothing about the source address.
const UPSTREAM_DOWN = new Set(['ECONNREFUSED', 'ECONNRESET']);

// Connects from the shared address when the OS allows it, so the service does not see a remote peer as loopback.
function connectUpstream(host: string, port: number, localAddress: string | undefined, track: (socket: net.Socket) => void): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, allowHalfOpen: true, ...(localAddress !== undefined ? { localAddress } : {}) });
    track(socket);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });
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
  const stopped = new AbortController();
  // Aborted by close, so a pending retry does not keep the process alive.
  const sleep = (ms: number): Promise<void> => delay(ms, undefined, { signal: stopped.signal }).catch(() => {});

  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const handle = async (client: net.Socket, listenAddress: string, upstreamHost: string): Promise<void> => {
    track(client);
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
      upstream = await connectUpstream(upstreamHost, spec.port, source, track);
    } catch (error) {
      if (source === undefined || UPSTREAM_DOWN.has((error as NodeJS.ErrnoException).code ?? '')) {
        client.destroy();
        return;
      }
      try {
        upstream = await connectUpstream(upstreamHost, spec.port, undefined, track);
      } catch {
        // Both failed: the service is down for a moment (e.g. a port-forward restarting), not the source address.
        client.destroy();
        return;
      }
      // Only the source address failed, as on macOS, which refuses loopback connections from a non-loopback source.
      localSourceWorks = false;
      log(spec, `cannot connect from ${source} (${(error as Error).message}); the service sees shared connections as local`);
    }
    if (closed || client.destroyed) {
      client.destroy();
      upstream.destroy();
      return;
    }
    pipe(client, upstream);
    client.resume();
  };

  const listen = (address: string, upstreamHost: string): Promise<'ok' | 'taken' | 'retry'> =>
    new Promise((resolve) => {
      // Half-open both ways: a client that ends its request still gets the reply.
      const server = net.createServer({ allowHalfOpen: true }, (client) => {
        void handle(client, address, upstreamHost);
      });
      server.once('error', (error: NodeJS.ErrnoException) => {
        server.close();
        resolve(error.code === 'EADDRINUSE' ? 'taken' : 'retry');
      });
      server.listen({ host: address, port: spec.port, exclusive: true }, () => {
        if (closed) server.close();
        else servers.push(server);
        resolve('ok');
      });
    });

  const run = async (): Promise<void> => {
    let upstreamHost: string | undefined;
    while (!closed && upstreamHost === undefined) {
      upstreamHost = await firstReachable(upstreamHosts(spec.upstream), spec.port);
      if (upstreamHost === undefined) await sleep(UPSTREAM_POLL_MS);
    }
    // In parallel: one address that is missing for a while must not hold up the others.
    await Promise.all(spec.addresses.map(async (address) => {
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
    }));
  };

  const close = async (): Promise<void> => {
    closed = true;
    stopped.abort();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  signal?.addEventListener('abort', () => void close(), { once: true });
  void run();
  return { close };
}
