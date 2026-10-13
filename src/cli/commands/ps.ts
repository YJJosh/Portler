import { loadConfig } from '../../config/index.ts';
import { readPids, serviceLiveness } from '../../process/index.ts';
import type { ServiceLiveness } from '../../process/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printTable } from '../table.ts';
import { selectServiceNames } from '../services.ts';

export async function commandPs(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(process.cwd(), args.file);
  // Only filter when names were requested: pids.json may hold entries for
  // services that were since renamed or removed from portler.yml.
  const selected = args.positionals.length > 0 ? new Set(selectServiceNames(config, args.positionals)) : null;
  const pids = await readPids(config.projectDir);
  const entries = Object.entries(pids?.services ?? {}).filter(([serviceName]) => !selected || selected.has(serviceName));

  if (entries.length === 0) {
    process.stdout.write('[portler] no services are running. Start some with "portler up -d".\n');
    return 0;
  }

  const liveness = await Promise.all(entries.map(([, info]) => serviceLiveness(config.projectDir, info)));
  const hasDocker = entries.some(([, info]) => info.dockerContainer);
  const hasImage = entries.some(([, info]) => info.image);
  const headers = ['SERVICE', 'MODE', 'PID', 'STATUS', 'PORT', 'URL', ...(hasDocker ? ['CONTAINER'] : []), ...(hasImage ? ['IMAGE'] : [])];
  const rows = entries.map(([serviceName, info], index) => {
    return [
      serviceName,
      `${info.dockerContainer ? 'docker' : 'local'}${info.prod ? ' (prod)' : ''}`,
      String(info.pid),
      statusLabel(liveness[index]!),
      info.port !== undefined ? String(info.port) : '-',
      info.url ?? '-',
      ...(hasDocker ? [info.dockerContainer ?? '-'] : []),
      ...(hasImage ? [info.image ?? '-'] : []),
    ];
  });

  printTable(headers, rows);
  entries.forEach(([serviceName, info], index) => {
    const entry = liveness[index]!;
    if (entry.status === 'unknown') {
      process.stderr.write(`[portler] warning: could not inspect container "${info.dockerContainer}" of ${serviceName}: ${entry.message}\n`);
    }
  });
  return 0;
}

/**
 * A Docker service whose supervising shell is gone but whose container runs on
 * is still serving: "running (container)", not dead.
 */
function statusLabel(liveness: ServiceLiveness): string {
  if (liveness.status === 'running') return liveness.via === 'pid' ? 'running' : 'running (container)';
  if (liveness.status === 'unknown') return 'unknown';
  return 'dead (stale)';
}
