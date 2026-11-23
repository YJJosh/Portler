import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { PROXY_SERVICE_NAME } from '../constants.ts';
import { readProcessStartToken } from '../process/identity.ts';
import { prefixStream } from '../process/logs.ts';
import type { Assignments, PidServiceInfo, PortlerConfig, ProxyConfig, ServiceAssignment, ShareSettings } from '../types/index.ts';
import { isWildcardHost } from '../share/tailnet.ts';
import type { ProxyServerOptions } from './server.ts';

// Only the type-stripping flags a dev checkout needs: flags like --inspect must not be inherited.
export function typeStrippingArgs(): string[] {
  return process.execArgv.filter((arg) => arg.includes('strip-types') || arg.includes('transform-types'));
}

function daemonPath(): string {
  const daemonFile = import.meta.url.endsWith('.ts') ? './daemon.ts' : './daemon.js';
  return fileURLToPath(new URL(daemonFile, import.meta.url));
}

export function buildProxyServerOptions(proxy: ProxyConfig, assignments: Assignments, share?: ShareSettings): ProxyServerOptions {
  const assignment = assignments[PROXY_SERVICE_NAME];
  if (!assignment) throw new Error('proxy has no assigned port');

  return {
    host: assignment.host,
    port: assignment.port,
    routes: proxy.routes.map((route) => {
      const target = assignments[route.service];
      if (!target) throw new Error(`proxy route "${route.prefix}" targets service "${route.service}" with no assigned port`);
      const local = share !== undefined && target.localUrlHost === undefined;
      return { prefix: route.prefix, service: route.service, host: target.host, port: target.port, ...(local ? { local: true as const } : {}) };
    }),
    // url_host is the name Portler prints; other non-loopback names need proxy.allowed_hosts.
    allowedHosts: [assignment.urlHost, ...(assignment.localUrlHost ? [assignment.localUrlHost] : []), ...(share?.hostNames ?? []), ...proxy.allowedHosts],
    trustedProxies: proxy.trustedProxies,
    // A wildcard proxy host already listens on the shared address; a second bind there would fail.
    ...(share && !isWildcardHost(assignment.host)
      ? { shareAddresses: share.addresses.filter((address) => address !== assignment.host), tailnetOnly: share.tailnetOnly }
      : {}),
  };
}

export function spawnProxy(proxy: ProxyConfig, assignments: Assignments, attachLogs: boolean, share?: ShareSettings): ChildProcess {
  const options = buildProxyServerOptions(proxy, assignments, share);
  const child = spawn(process.execPath, [...typeStrippingArgs(), daemonPath(), JSON.stringify(options)], {
    // Its own process group, so stopServices can signal -pid, in foreground mode too (see spawnService).
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
    ...(config.share ? { share: config.share } : {}),
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    startedAt: new Date().toISOString(),
  };
}
