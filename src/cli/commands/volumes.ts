import { loadConfig, projectVolumePrefix } from '../../config/index.ts';
import { forkVolume, listProjectVolumes, removeVolume } from '../../volumes/index.ts';
import type { PortlerConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printTable } from '../table.ts';

async function listVolumes(config: PortlerConfig): Promise<number> {
  const volumes = await listProjectVolumes(config);

  if (volumes.length === 0) {
    process.stdout.write('[portler] no project volumes. Declare one with "@name:/path" under a service\'s volumes.\n');
    return 0;
  }

  printTable(
    ['VOLUME', 'SET', 'SERVICES', 'SIZE', 'IN USE BY'],
    volumes.map((volume) => [
      volume.name,
      volume.volumeSet ?? '-',
      volume.services.join(',') || '-',
      volume.exists ? (volume.size ?? '-') : 'not created',
      volume.usedBy.join(',') || '-',
    ]),
  );

  process.stdout.write(`\n[portler] Docker name prefix: ${projectVolumePrefix(config.volumeRoot)}\n`);
  if (config.volumeSet) process.stdout.write(`[portler] active volume set: ${config.volumeSet}\n`);
  return 0;
}

export async function commandVolumes(args: ParsedArgs): Promise<number> {
  const [subcommand = 'list', ...rest] = args.positionals;
  if (args.force && subcommand !== 'remove' && subcommand !== 'rm') {
    throw new Error('--force only applies to "portler volumes remove"');
  }

  const config = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });

  switch (subcommand) {
    case 'list':
    case 'ls':
      if (rest.length > 0) throw new Error('usage: portler volumes [list]');
      return listVolumes(config);

    case 'fork': {
      const [volumeArg, newSet, extra] = rest;
      if (!volumeArg || !newSet || extra !== undefined) throw new Error('usage: portler volumes fork <volume> <new-set>');
      const fork = await forkVolume(config, volumeArg, newSet);
      process.stdout.write(`[portler] forked ${fork.source}\n[portler]     -> ${fork.target}\n`);
      process.stdout.write(`[portler] run against it with "portler up --volume-set ${fork.volumeSet}" (or PORTLER_VOLUME_SET=${fork.volumeSet})\n`);
      return 0;
    }

    case 'remove':
    case 'rm': {
      const [volumeArg, extra] = rest;
      if (!volumeArg || extra !== undefined) throw new Error('usage: portler volumes remove <volume> [--force]');
      const removed = await removeVolume(config, volumeArg, args.force);
      process.stdout.write(`[portler] removed volume ${removed}\n`);
      return 0;
    }

    default:
      throw new Error(`unknown volumes subcommand "${subcommand}" (expected list, fork, or remove)`);
  }
}
