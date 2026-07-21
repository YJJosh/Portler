import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { readState } from '../../state/index.ts';
import type { ParsedArgs } from '../args.ts';
import { printPortTable } from '../table.ts';

export async function commandPorts(args: ParsedArgs): Promise<number> {
  const config = await loadConfig(process.cwd(), args.file);
  const state = await readState(config.projectDir);

  if (!state) {
    process.stdout.write('[portler] no state yet. Run "portler up" or "portler env" first.\n');
    return 0;
  }

  printPortTable(state.services);

  const proxyAssignment = config.proxy ? state.services[PROXY_SERVICE_NAME] : undefined;
  if (proxyAssignment) process.stdout.write(`[portler] project url: ${proxyAssignment.url}\n`);

  return 0;
}
