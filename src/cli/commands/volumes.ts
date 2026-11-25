import { loadConfig, volumeScope } from '../../config/index.ts';
import { applyProduction } from '../../config/production.ts';
import { forkVolume, listProjectVolumes, removeVolume } from '../../volumes/index.ts';
import { shellQuote } from '../../process/docker.ts';
import type { PortlerConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printTable } from '../table.ts';

async function listVolumes(config: PortlerConfig, json: boolean): Promise<number> {
  const volumes = await listProjectVolumes(config);

  // `owner` is the portler.project label value a tool must set on volumes it creates for this project.
  if (json) {
    const scope = volumeScope(config);
    const rows = volumes.map((v) => ({ name: v.name, fullName: v.fullName, volumeSet: v.volumeSet ?? null, services: v.services, exists: v.exists, size: v.size ?? null, usedBy: v.usedBy }));
    process.stdout.write(`${JSON.stringify({ prefix: scope.prefix, owner: scope.owner, volumeSet: config.volumeSet ?? null, volumes: rows }, null, 2)}\n`);
    return 0;
  }

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

  process.stdout.write(`\n[portler] Docker name prefix: ${volumeScope(config).prefix}\n`);
  if (config.production) process.stdout.write(`[portler] production scope: ${config.name ? `name "${config.name}"` : 'no name set, directory hash'}\n`);
  if (config.volumeSet) process.stdout.write(`[portler] active volume set: ${config.volumeSet}\n`);
  return 0;
}

/** Repeats --file and --prod: both decide the volume scope, so without them `up` would
 * mount another project's or the development variant. */
export function forkUpCommand(volumeSet: string, args: Pick<ParsedArgs, 'file' | 'prod'>): string {
  const parts = ['portler', 'up'];
  if (args.file) parts.push('--file', shellQuote(args.file));
  if (args.prod) parts.push('--prod');
  parts.push('--volume-set', shellQuote(volumeSet));
  return parts.join(' ');
}

export async function commandVolumes(args: ParsedArgs): Promise<number> {
  const [subcommand = 'list', ...rest] = args.positionals;
  if (args.json && !['list', 'ls'].includes(subcommand)) throw new Error('--json only applies to "portler volumes list"');
  if (args.force && !['remove', 'rm', 'fork'].includes(subcommand)) {
    throw new Error('--force only applies to "portler volumes remove" and "portler volumes fork"');
  }

  const config = applyProduction(await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet }), args.prod);

  switch (subcommand) {
    case 'list':
    case 'ls':
      if (rest.length > 0) throw new Error('usage: portler volumes [list]');
      return listVolumes(config, args.json);

    case 'fork': {
      const [volumeArg, newSet, extra] = rest;
      if (!volumeArg || !newSet || extra !== undefined) throw new Error('usage: portler volumes fork <volume> <new-set> [--force]');
      const fork = await forkVolume(config, volumeArg, newSet, args.force);
      process.stdout.write(`[portler] forked ${fork.source}\n[portler]     -> ${fork.target}\n`);
      process.stdout.write(`[portler] run against it with "${forkUpCommand(fork.volumeSet, args)}" (or PORTLER_VOLUME_SET=${fork.volumeSet} instead of --volume-set)\n`);
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
