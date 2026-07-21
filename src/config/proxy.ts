import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS, PROXY_SERVICE_NAME } from '../constants.ts';
import { isPort } from '../util/guards.ts';
import { isObject, normalizeStringArray, optionalString } from './scalars.ts';
import type { PortlerConfig, ProxyConfig, ProxyRoute, ServiceConfig, UnknownMap } from '../types/index.ts';

/** `port: auto` (or omitting the key) asks Portler to pick a free port. */
function normalizeProxyPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === 'auto') return undefined;
  if (!isPort(value)) throw new Error('proxy.port must be "auto" or a port number');
  return value;
}

/** Trim a trailing slash so '/api' and '/api/' route identically ('/' stays). */
function normalizeRoutePrefix(rawPrefix: string): string {
  if (!rawPrefix.startsWith('/')) throw new Error(`proxy route "${rawPrefix}" must start with "/"`);
  if (rawPrefix !== '/' && rawPrefix.endsWith('/')) return rawPrefix.slice(0, -1);
  return rawPrefix;
}

/**
 * Normalize the top-level `proxy:` block into route entries sorted
 * longest-prefix-first, validating that every route targets a known service
 * that declares a port (otherwise there is nothing to forward to).
 */
export function normalizeProxyConfig(root: UnknownMap, services: Record<string, ServiceConfig>): ProxyConfig | undefined {
  const rawProxy = root.proxy;
  if (rawProxy === undefined || rawProxy === null) return undefined;
  if (!isObject(rawProxy)) throw new Error('proxy must be an object with routes');

  if (services[PROXY_SERVICE_NAME]) {
    throw new Error(`service name "${PROXY_SERVICE_NAME}" is reserved when a proxy block exists; rename the service`);
  }

  const rawRoutes = rawProxy.routes;
  if (!isObject(rawRoutes) || Object.keys(rawRoutes).length === 0) {
    throw new Error('proxy.routes must map at least one path prefix to a service, e.g. "/: web"');
  }

  const routes: ProxyRoute[] = [];
  const seenPrefixes = new Set<string>();

  for (const [rawPrefix, rawService] of Object.entries(rawRoutes)) {
    const serviceName = optionalString(rawService, `proxy.routes.${rawPrefix}`);
    if (!serviceName) throw new Error(`proxy.routes.${rawPrefix} must name a service`);

    const prefix = normalizeRoutePrefix(rawPrefix);
    if (seenPrefixes.has(prefix)) throw new Error(`proxy route "${prefix}" is defined twice`);
    seenPrefixes.add(prefix);

    const service = services[serviceName];
    if (!service) throw new Error(`proxy route "${prefix}" targets unknown service "${serviceName}"`);
    if (service.port === undefined) {
      throw new Error(`proxy route "${prefix}" targets service "${serviceName}" which has no port`);
    }

    routes.push({ prefix, service: serviceName });
  }

  routes.sort((a, b) => b.prefix.length - a.prefix.length);

  return {
    port: normalizeProxyPort(rawProxy.port),
    routes,
    allowedHosts: normalizeStringArray(rawProxy.allowed_hosts ?? rawProxy.allowedHosts, 'proxy.allowed_hosts'),
  };
}

/**
 * Synthetic ServiceConfig representing the proxy, so port allocation treats
 * it exactly like any other service that declares a port.
 */
export function proxyServiceConfig(config: PortlerConfig, proxy: ProxyConfig): ServiceConfig {
  return {
    name: PROXY_SERVICE_NAME,
    cwd: '.',
    port: proxy.port,
    portEnv: [],
    env: {},
    host: config.host,
    urlHost: config.urlHost,
    protocol: config.protocol,
    preferDeclaredPort: proxy.port !== undefined,
    dependsOn: [],
    // Explicit, because the default healthcheck keys off the DECLARED port,
    // which is undefined for `port: auto` — the proxy always listens.
    healthcheck: {
      type: 'tcp',
      timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
      intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
    },
  };
}
