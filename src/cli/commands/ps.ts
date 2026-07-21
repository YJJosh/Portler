import { loadConfig } from '../../config/index.ts';
import { isPidRunning, readPids } from '../../process/index.ts';
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

  const hasDocker = entries.some(([, info]) => info.dockerContainer);
  const headers = ['SERVICE', 'MODE', 'PID', 'STATUS', 'PORT', 'URL', ...(hasDocker ? ['CONTAINER'] : [])];
  const rows = entries.map(([serviceName, info]) => {
    return [
      serviceName,
      info.dockerContainer ? 'docker' : 'local',
      String(info.pid),
      isPidRunning(info.pid) ? 'running' : 'dead (stale)',
      info.port !== undefined ? String(info.port) : '-',
      info.url ?? '-',
      ...(hasDocker ? [info.dockerContainer ?? '-'] : []),
    ];
  });

  printTable(headers, rows);
  return 0;
}
