/**
 * Reverse proxy server for the top-level `proxy:` block.
 *
 * Routing is longest-prefix-first with path-segment boundaries ('/api'
 * matches '/api' and '/api/users' but not '/apifoo'). The matched prefix is
 * NOT stripped: the upstream service receives the original URL, like most
 * dev proxies. The Host header is preserved and X-Forwarded-For/Proto/Host
 * are set; WebSocket upgrades are piped through raw net sockets.
 */
import http from 'node:http';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObject, isPort, isString } from '../util/guards.ts';
import { normalizeIpAddress } from '../util/ip.ts';

export interface ProxyTarget {
  /** Normalized route prefix ('/' or '/api' — no trailing slash otherwise). */
  prefix: string;
  /** Service name, used in 502 messages. */
  service: string;
  host: string;
  port: number;
}

export interface ProxyServerOptions {
  host: string;
  port: number;
  /** Sorted longest-prefix-first; the first match wins. */
  routes: ProxyTarget[];
  /**
   * Hostnames (no port) the proxy answers for. A request whose Host header is
   * not in this list is rejected — see isAllowedHost.
   */
  allowedHosts: string[];
  /** Exact peer IP allowlist; loopback is not implicitly trusted. */
  trustedProxies: string[];
}

function isProxyTarget(value: unknown): value is ProxyTarget {
  return isObject(value) && isString(value.prefix) && isString(value.service) && isString(value.host) && isPort(value.port);
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
    value.trustedProxies.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined)
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

/**
 * DNS-rebinding guard.
 *
 * By default the proxy listens on a loopback port with no authentication, which is fine
 * as long as only local clients can reach it. But any web page the developer
 * visits can make their browser send requests to http://127.0.0.1:<port> — and
 * with a DNS rebind (attacker.com briefly resolving to 127.0.0.1) those
 * requests carry `Host: attacker.com` and are treated as same-origin by the
 * browser, letting a remote page read the responses of every service behind the
 * proxy. Browsers cannot forge the Host header, so pinning it to the names the
 * proxy is actually reachable under closes the hole: a rebound request arrives
 * with the attacker's hostname and is refused.
 *
 * `*.localhost` is allowed because it always resolves to loopback per RFC 6761.
 * A bare IP literal is allowed only when it is a loopback address.
 */
export function isAllowedHost(hostHeader: string | undefined, allowedHosts: readonly string[]): boolean {
  // HTTP/1.0 clients (and some probes) send no Host header. They cannot be a
  // browser rebinding attack, which always sets one.
  if (hostHeader === undefined || hostHeader === '') return true;

  if (!isValidAuthority(hostHeader)) return false;
  const hostname = hostnameOf(hostHeader);
  if (hostname === '') return false;

  if (allowedHosts.some((allowed) => allowed.toLowerCase() === hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '[::1]' || hostname === '::1') return true;
  // 127.0.0.0/8 is entirely loopback, but only accept a real IPv4 literal.
  // Numeric-looking DNS names such as 127.0.0.1.999 must not bypass the Host
  // guard if a resolver happens to accept them.
  if (net.isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127) return true;

  return false;
}

function rejectForbiddenHost(hostHeader: string | undefined): string {
  return (
    `portler proxy: refusing request with Host "${hostHeader ?? ''}".\n` +
    'The proxy only answers for localhost / loopback names (DNS-rebinding protection). ' +
    'If you reach this project under another hostname, set proxy.allowed_hosts in portler.yml.\n'
  );
}

/**
 * Pick the first (= longest, routes are pre-sorted) route whose prefix
 * matches the request path on a path-segment boundary.
 */
export function matchRoute(routes: ProxyTarget[], url: string): ProxyTarget | undefined {
  const queryIndex = url.indexOf('?');
  const path = queryIndex === -1 ? url : url.slice(0, queryIndex);

  for (const route of routes) {
    if (route.prefix === '/') return route;
    if (path === route.prefix || path.startsWith(`${route.prefix}/`)) return route;
  }

  return undefined;
}

/** Headers that describe the client connection and must not be forwarded. */
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

/** Header names listed in the Connection header are hop-by-hop too. */
function connectionListedHeaders(connectionHeader: string | string[] | undefined): Set<string> {
  const names = new Set<string>();
  const raw = Array.isArray(connectionHeader) ? connectionHeader.join(',') : (connectionHeader ?? '');

  for (const token of raw.split(',')) {
    const name = token.trim().toLowerCase();
    if (name) names.add(name);
  }

  return names;
}

/** Only these three forwarding headers are supported; never relay competing metadata. */
function isForwardingHeader(name: string): boolean {
  return name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-');
}

/** A single authority, not a URL, comma-separated list, userinfo or scoped IP. */
function isValidAuthority(value: string): boolean {
  const match = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match) return false;
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return false;
  const hostname = match[1]!;
  if (hostname.startsWith('[')) return net.isIP(hostname.slice(1, -1)) === 6;
  return hostname.length <= 253 && hostname.replace(/\.$/, '').split('.').every(
    (label) => label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  );
}

/** Shared by HTTP and upgrades: trust only a validated, explicitly allowlisted peer. */
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

function handleRequest(options: ProxyServerOptions, req: IncomingMessage, res: ServerResponse): void {
  if (!isAllowedHost(req.headers.host, options.allowedHosts)) {
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

  const upstream = http.request({
    host: route.host,
    port: route.port,
    method: req.method,
    // The full original URL — route prefixes are intentionally not stripped.
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

  // Client gone (or response finished): make sure the upstream request dies too.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

/** Rebuild an upgrade head, retaining only the required upgrade hop. */
function rawUpgradeHead(req: IncomingMessage, options: ProxyServerOptions): string {
  const lines = [`${req.method} ${req.url ?? '/'} HTTP/${req.httpVersion}`];
  const connectionListed = connectionListedHeaders(req.headers.connection);

  // REVIEW: Upgrades must sanitize the same proxy credentials and nominated
  // hop headers as HTTP. Relaying the raw Connection list also incorrectly
  // nominates our newly generated forwarding metadata as hop-by-hop upstream.
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]!.toLowerCase();
    if (isForwardingHeader(name) || HOP_BY_HOP_HEADERS.has(name) || connectionListed.has(name)) continue;
    lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
  }
  lines.push('Connection: Upgrade', `Upgrade: ${req.headers.upgrade}`);
  for (const [name, value] of Object.entries(forwardingHeaders(req, options))) lines.push(`${name}: ${value}`);

  return `${lines.join('\r\n')}\r\n\r\n`;
}

function handleUpgrade(options: ProxyServerOptions, req: IncomingMessage, socket: net.Socket, head: Buffer): void {
  socket.on('error', () => {});

  // WebSockets are not protected by the same-origin policy, so an unchecked
  // Host here would reopen exactly the rebinding hole the request path closes.
  if (!isAllowedHost(req.headers.host, options.allowedHosts)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }

  const route = matchRoute(options.routes, req.url ?? '/');
  if (!route) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
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

/** Start the proxy server; resolves once it is listening. */
export function startProxyServer(options: ProxyServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => handleRequest(options, req, res));
  server.on('upgrade', (req, socket, head) => handleUpgrade(options, req, socket as net.Socket, head));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
