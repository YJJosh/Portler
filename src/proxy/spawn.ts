import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { PROXY_SERVICE_NAME } from '../constants.ts';
import { readProcessStartToken } from '../process/identity.ts';
import { prefixStream } from '../process/logs.ts';
import type { Assignments, PidServiceInfo, PortlerConfig, ProxyConfig, ServiceAssignment } from '../types/index.ts';
import type { ProxyServerOptions } from './server.ts';

/**
 * Node flags the daemon needs to execute TypeScript directly when running
 * from a dev checkout (dist runs plain JS and needs none). Deliberately not
 * the whole execArgv: flags like --inspect must not be inherited.
 */
function typeStrippingArgs(): string[] {
  return process.execArgv.filter((arg) => arg.includes('strip-types') || arg.includes('transform-types'));
}

/** Dev checkouts run daemon.ts; the compiled dist layout runs daemon.js. */
function daemonPath(): string {
  const daemonFile = import.meta.url.endsWith('.ts') ? './daemon.ts' : './daemon.js';
  return fileURLToPath(new URL(daemonFile, import.meta.url));
}

/** Resolve the proxy routes to the services' assigned localhost ports. */
export function buildProxyServerOptions(proxy: ProxyConfig, assignments: Assignments): ProxyServerOptions {
  const assignment = assignments[PROXY_SERVICE_NAME];
  if (!assignment) throw new Error('proxy has no assigned port');

  return {
    host: assignment.host,
    port: assignment.port,
    routes: proxy.routes.map((route) => {
      const target = assignments[route.service];
      if (!target) throw new Error(`proxy route "${route.prefix}" targets service "${route.service}" with no assigned port`);
      return { prefix: route.prefix, service: route.service, host: target.host, port: target.port };
    }),
    // The project's own url_host is always legitimate — it is the name Portler
    // itself prints and tells services to use. Loopback names are allowed
    // unconditionally by isAllowedHost; anything else must be opted into via
    // proxy.allowed_hosts.
    allowedHosts: [assignment.urlHost, ...proxy.allowedHosts],
  };
}

/** Spawn the proxy daemon in its own process group, like spawnService. */
export function spawnProxy(proxy: ProxyConfig, assignments: Assignments, attachLogs: boolean): ChildProcess {
  const options = buildProxyServerOptions(proxy, assignments);
  const child = spawn(process.execPath, [...typeStrippingArgs(), daemonPath(), JSON.stringify(options)], {
    // detached gives the proxy its own process group so stopServices can
    // signal -pid — required even in foreground mode (see spawnService).
    detached: true,
    stdio: attachLogs ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
  });

  if (attachLogs) {
    if (child.stdout) prefixStream(PROXY_SERVICE_NAME, child.stdout, process.stdout);
    if (child.stderr) prefixStream(PROXY_SERVICE_NAME, child.stderr, process.stderr);
  }

  child.on('error', (error) => {
    process.stderr.write(`[${PROXY_SERVICE_NAME}] failed to start: ${error.message}\n`);
  });

  process.stdout.write(`[portler] ${PROXY_SERVICE_NAME}: ${assignments[PROXY_SERVICE_NAME]!.url} (pid ${child.pid ?? 'unknown'})\n`);

  return child;
}

/** Build the pids.json record for the proxy daemon. */
export async function proxyPidInfoFor(
  config: PortlerConfig,
  child: ChildProcess,
  assignment: ServiceAssignment,
): Promise<PidServiceInfo> {
  if (child.pid === undefined) throw new Error('proxy did not start with a process id');

  return {
    pid: child.pid,
    command: 'portler proxy',
    cwd: config.projectDir,
    port: assignment.port,
    url: assignment.url,
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    startedAt: new Date().toISOString(),
  };
}
