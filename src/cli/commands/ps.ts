import { loadConfig } from '../../config/index.ts';
import { K8S_FORWARD_COMMAND } from '../../k8s/index.ts';
import { readPids, serviceLiveness } from '../../process/index.ts';
import type { ServiceLiveness } from '../../process/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { isTcpReady } from '../../readiness/index.ts';
import { sharesPort } from '../../share/settings.ts';
import type { PidServiceInfo, PortlerConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { portLabel, printTable } from '../table.ts';
import { selectServiceTargets } from '../services.ts';

export async function commandPs(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(process.cwd(), args.file);
  // Only filter when names were requested: pids.json may hold entries for
  // services that were since renamed or removed from portler.yml.
  const selected = args.positionals.length > 0 ? new Set(selectServiceTargets(config, args.positionals)) : null;
  const pids = await readPids(config.projectDir);
  const entries = Object.entries(pids?.services ?? {}).filter(([serviceName]) => !selected || selected.has(serviceName));

  if (entries.length === 0) {
    process.stdout.write('[portler] no services are running. Start some with "portler up -d".\n');
    return 0;
  }

  const liveness = await Promise.all(entries.map(([, info]) => serviceLiveness(config.projectDir, info)));
  const shared = await Promise.all(entries.map(([serviceName, info], index) => sharedLabel(config, serviceName, info, liveness[index]!)));
  const hasDocker = entries.some(([, info]) => info.dockerContainer);
  const hasImage = entries.some(([, info]) => info.image);
  const hasShare = entries.some(([, info]) => info.share);
  const headers = [
    'SERVICE', 'MODE', 'PID', 'STATUS', 'PORT', 'URL',
    ...(hasShare ? ['SHARED'] : []), ...(hasDocker ? ['CONTAINER'] : []), ...(hasImage ? ['IMAGE'] : []),
  ];
  const rows = entries.map(([serviceName, info], index) => {
    const mode = modeLabel(info);
    // kubectl port-forward carries TCP only.
    const transport = mode.startsWith('k8s') ? undefined : config.services[serviceName]?.transport;
    return [
      serviceName,
      mode,
      String(info.pid),
      statusLabel(liveness[index]!),
      info.port !== undefined ? portLabel(info.port, transport) : '-',
      info.url ?? '-',
      ...(hasShare ? [shared[index]!] : []),
      ...(hasDocker ? [info.dockerContainer ?? '-'] : []),
      ...(hasImage ? [info.image ?? '-'] : []),
    ];
  });

  printTable(headers, rows);
  entries.forEach(([serviceName, info], index) => {
    const entry = liveness[index]!;
    if (entry.status === 'running' && entry.via === 'group') {
      process.stderr.write(`[portler] warning: ${serviceName}: ${entry.message}\n`);
    }
    if (entry.status === 'unknown') {
      process.stderr.write(`[portler] warning: could not inspect container "${info.dockerContainer}" of ${serviceName}: ${entry.message}\n`);
    }
  });
  return 0;
}

// Asks the shared address itself, since the forwarder can be missing while the service runs (e.g. a bind it could not make).
async function sharedLabel(config: PortlerConfig, serviceName: string, info: PidServiceInfo, liveness: ServiceLiveness): Promise<string> {
  if (!info.share || info.port === undefined || liveness.status === 'dead') return '-';
  const service = config.services[serviceName];
  const isProxy = config.proxy !== undefined && serviceName === PROXY_SERVICE_NAME;
  if (!isProxy && (!service || !sharesPort(service))) return '-';
  return (await isTcpReady(info.share.addresses[0]!, info.port, SHARE_PROBE_MS)) ? 'yes' : 'not reachable';
}

const SHARE_PROBE_MS = 1_000;

// Entries without a runMode are k8s if their command is the port-forward supervisor.
function modeLabel(info: PidServiceInfo): string {
  const k8s = info.runMode === 'k8s' || info.command.startsWith(`${K8S_FORWARD_COMMAND} `);
  const mode = k8s ? 'k8s' : info.dockerContainer ? 'docker' : 'local';
  return `${mode}${info.prod ? ' (prod)' : ''}`;
}

// A Docker service whose shell is gone but whose container runs on is still serving.
function statusLabel(liveness: ServiceLiveness): string {
  if (liveness.status === 'running') return liveness.via === 'pid' ? 'running' : `running (${liveness.via})`;
  if (liveness.status === 'unknown') return 'unknown';
  return 'dead (stale)';
}
