import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObject, isPort, isString } from '../util/guards.ts';
import { normalizeIpAddress } from '../util/ip.ts';
import { isTailnetAddress } from '../share/tailnet.ts';

export interface ProxyTarget {
  /** Normalized route prefix ('/' or '/api' — no trailing slash otherwise). */
  prefix: string;
  /** Service name, used in 502 messages. */
  service: string;
  host: string;
  port: number;
  /** A `share: false` service: the shared listeners refuse this route. */
  local?: true;
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  /** Sorted longest-prefix-first; the first match wins. */
  routes: ProxyTarget[];
  /** Hostnames (no port) the proxy answers for besides loopback names; see isAllowedHost. */
  allowedHosts: string[];
  /** Exact peer IP allowlist; loopback is not implicitly trusted. */
  trustedProxies: string[];
  /** `--share`: more addresses to listen on, besides `host`. */
  shareAddresses?: string[];
  /** `--share`: a connection to one of these local addresses is a shared one, whichever listener took it. */
  sharedAddresses?: string[];
  /** Refuse peers outside the tailnet on shared connections. */
  tailnetOnly?: boolean;
}

function isProxyTarget(value: unknown): value is ProxyTarget {
  return (
    isObject(value) && isString(value.prefix) && isString(value.service) && isString(value.host) && isPort(value.port) &&
    (value.local === undefined || value.local === true)
  );
}

export function isProxyServerOptions(value: unknown): value is ProxyServerOptions {
  return (
    isObject(value) &&
    isString(value.host) &&
    isPort(value.port) &&
    Array.isArray(value.routes) &&
    value.routes.length > 0 &&
    value.routes.every(isProxyTarget) &&
    Array.isArray(value.allowedHosts) &&
    value.allowedHosts.every(isString) &&
    Array.isArray(value.trustedProxies) &&
    value.trustedProxies.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined) &&
    (value.shareAddresses === undefined ||
      (Array.isArray(value.shareAddresses) && value.shareAddresses.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined))) &&
    (value.sharedAddresses === undefined ||
      (Array.isArray(value.sharedAddresses) && value.sharedAddresses.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined))) &&
    (value.tailnetOnly === undefined || typeof value.tailnetOnly === 'boolean')
  );
}

/** Strip the `:port` from a Host header, handling bracketed IPv6 literals. */
export function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim();

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value.toLowerCase() : value.slice(0, end + 1).toLowerCase();
  }

  const colon = value.indexOf(':');
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

/** DNS-rebinding guard (the proxy has no auth): browsers cannot forge Host, so a page that rebinds attacker.com to 127.0.0.1
 * sends `Host: attacker.com` and is refused. `*.localhost` is always loopback (RFC 6761); IP literals must be loopback. */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  // HTTP/1.0 clients send no Host; a browser, and so a rebinding attack, always does.
  if (hostHeader === undefined || hostHeader === '') return true;

  if (!isValidAuthority(hostHeader)) return false;
  const hostname = hostnameOf(hostHeader);
  if (hostname === '') return false;

  if (allowedHosts.some((allowed) => allowed.toLowerCase() === hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '[::1]' || hostname === '::1') return true;
  // A real IPv4 literal only: a DNS name such as 127.0.0.1.999 must not pass.
  if (net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127) return true;

  return false;
}

// Refuses duplicate Host headers: Node checks only the first, but an upstream with another parser may route on a later one.
function hasAllowedRequestHost(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]!.toLowerCase() === 'host') count += 1;
  }
  return count <= 1 && isAllowedHost(req.headers.host, allowedHosts);
}

function rejectForbiddenHost(hostHeader: string | undefined): string {
  return (
    `portler proxy: refusing request with Host "${hostHeader ?? ''}".\n` +
    'The proxy only answers for localhost / loopback names and, with --share, the shared address (DNS-rebinding protection). ' +
    'If you reach this project under another hostname, set proxy.allowed_hosts in portler.yml.\n'
  );
}

/** Routes are sorted longest first. '/api' matches '/api' and '/api/users', not '/apifoo'. */
export function matchRoute(routes: ProxyTarget[], url: string): ProxyTarget | undefined {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);

  for (const route of routes) {
    if (route.prefix === '/') return route;
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) return route;
  }

  return undefined;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

// Header names listed in the Connection header are hop-by-hop too.
function connectionListedHeaders(connectionHeader: string | string[] | undefined): Set<string> {
  const names = new Set<string>();
  const raw = Array.isArray(connectionHeader) ? connectionHeader.join(',') : (connectionHeader ?? '');

  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase();
    if (name) names.add(name);
  }

  return names;
}

// Dropped from client requests: the proxy sets X-Forwarded-For/Proto/Host itself.
function isForwardingHeader(name: string): boolean {
  return name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-');
}

// A single authority, not a URL, list, userinfo or scoped IP. Underscores pass: invalid in public DNS, but
// container names such as `my_app` use them.
function isValidAuthority(value: string): boolean {
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)(?::([0-9]+))?$/.exec(value);
  if (!match) return false;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  const hostname = match[1]!;
  if (hostname.startsWith('[')) return net.isIP(hostname.slice(1, -1)) === 6;
  return hostname.length <= 253 && hostname.replace(/\.$/, '').split('.').every(
    (label) => label.length <= 63 && /^[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?$/.test(label),
  );
}

// Shared by HTTP and upgrades: trust only a validated, explicitly allowlisted peer.
function forwardingHeaders(req: IncomingMessage, options: ProxyServerOptions): Record<string, string> {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown';
  const peer = normalizeIpAddress(remoteAddress);
  const trusted = peer !== undefined && options.trustedProxies.some((ip) => normalizeIpAddress(ip) === peer);
  const connectionListed = connectionListedHeaders(req.headers.connection);
  const supported = (name: string): string | undefined => {
    const value = req.headers[name];
    return trusted && !connectionListed.has(name) && typeof value === 'string' ? value : undefined;
  };
  const proto = supported('x-forwarded-proto');
  const host = supported('x-forwarded-host');
  const chain = supported('x-forwarded-for')?.split(',').map((ip) => ip.trim());
  const validChain = chain && chain.length > 0 && chain.every((ip) => normalizeIpAddress(ip) !== undefined);
  const headers: Record<string, string> = {
    'x-forwarded-for': validChain ? `${chain.join(', ')}, ${remoteAddress}` : remoteAddress,
    'x-forwarded-proto': proto === 'http' || proto === 'https' ? proto : 'http',
  };
  if (host && isAllowedHost(host, options.allowedHosts)) {
    headers['x-forwarded-host'] = host;
  } else if (req.headers.host) {
    headers['x-forwarded-host'] = req.headers.host;
  }
  return headers;
}

function forwardedRequestHeaders(req: IncomingMessage, options: ProxyServerOptions): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const connectionListed = connectionListedHeaders(req.headers.connection);

  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name) || isForwardingHeader(name)) continue;
    headers[name] = value;
  }

  // Keep the checked Host even when Connection lists it; otherwise http.request
  // sends the upstream's own address.
  if (req.headers.host !== undefined) headers.host = req.headers.host;
  return { ...headers, ...forwardingHeaders(req, options) };
}

function forwardedResponseHeaders(upstreamRes: IncomingMessage): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const connectionListed = connectionListedHeaders(upstreamRes.headers.connection);

  for (const [name, value] of Object.entries(upstreamRes.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name)) continue;
    headers[name] = value;
  }

  return headers;
}

function badGatewayMessage(route: ProxyTarget, error: Error): string {
  return `portler proxy: service "${route.service}" is not reachable at ${route.host}:${route.port} (${error.message})\n`;
}

function handleRequest(options: ProxyServerOptions, shared: boolean, req: IncomingMessage, res: ServerResponse): void {
  if (!hasAllowedRequestHost(req, options.allowedHosts)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(rejectForbiddenHost(req.headers.host));
    return;
  }

  const routes = options.routes;
  const route = matchRoute(routes, req.url ?? '/');

  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`portler proxy: no route matches ${req.url ?? '/'}\n`);
    return;
  }
  if (shared && route.local) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`portler proxy: service "${route.service}" is not shared (share: false)\n`);
    return;
  }

  const upstream = http.request({
    host: route.host,
    port: route.port,
    method: req.method,
    // Route prefixes are not stripped.
    path: req.url,
    headers: forwardedRequestHeaders(req, options),
  });

  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, forwardedResponseHeaders(upstreamRes));
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(badGatewayMessage(route, error));
  });

  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

// Strips the same headers as HTTP. The client's Connection list is not relayed: it could nominate our
// forwarding headers as hop-by-hop upstream.
function rawUpgradeHead(req: IncomingMessage, options: ProxyServerOptions): string {
  const lines = [`${req.method} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
  const connectionListed = connectionListedHeaders(req.headers.connection);

  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (name === 'host' || isForwardingHeader(name) || HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name)) continue;
    lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
  }
  // The single checked Host, even when Connection lists it.
  if (req.headers.host !== undefined) lines.push(`Host: ${req.headers.host}`);
  lines.push('Connection: Upgrade', `Upgrade: ${req.headers.upgrade}`);
  for (const [name, value] of Object.entries(forwardingHeaders(req, options))) lines.push(`${name}: ${value}`);

  return `${lines.join('\r\n')}\r\n\r\n`;
}

function handleUpgrade(options: ProxyServerOptions, shared: boolean, req: IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.on('error', () => {});

  // WebSockets are not covered by the same-origin policy, so they need the Host check too.
  if (!hasAllowedRequestHost(req, options.allowedHosts)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  const route = matchRoute(options.routes, req.url ?? '/');
  if (!route) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  if (shared && route.local) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  let handshakeSent = false;
  const upstream = net.connect(route.port, route.host, () => {
    handshakeSent = true;
    upstream.write(rawUpgradeHead(req, options));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', (error) => {
    if (handshakeSent) {
      socket.destroy();
      return;
    }
    socket.end(
      `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${badGatewayMessage(route, error)}`,
    );
  });

  upstream.on('close', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

// By the address the connection came in on, so a proxy on 0.0.0.0 treats its tailnet connections as shared too.
function isSharedConnection(options: ProxyServerOptions, socket: net.Socket): boolean {
  const local = normalizeIpAddress(socket.localAddress ?? '');
  return local !== undefined && (options.sharedAddresses ?? []).includes(local);
}

function createProxyServer(options: ProxyServerOptions): http.Server {
  const server = http.createServer((req, res) => handleRequest(options, isSharedConnection(options, req.socket), req, res));
  server.on('upgrade', (req, socket, head) => handleUpgrade(options, isSharedConnection(options, req.socket), req, socket as net.Socket, head));
  if (options.tailnetOnly) {
    server.on('connection', (socket: net.Socket) => {
      if (isSharedConnection(options, socket) && !isTailnetAddress(socket.remoteAddress ?? '')) socket.destroy();
    });
  }
  return server;
}

function listen(server: http.Server, port: number, host: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** Resolves once the server is listening. */
export function startProxyServer(options: ProxyServerOptions): Promise<http.Server> {
  return listen(createProxyServer(options), options.port, options.host);
}

/** One listener per share address, on the proxy's port. Closing them is up to the caller. */
export async function startProxyShareServers(options: ProxyServerOptions): Promise<http.Server[]> {
  const servers: http.Server[] = [];
  try {
    for (const address of options.shareAddresses ?? []) {
      const server = createProxyServer(options);
      servers.push(await listen(server, options.port, address));
    }
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  return servers;
}
