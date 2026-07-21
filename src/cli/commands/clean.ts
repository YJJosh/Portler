import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../config/index.ts';
import { pruneGlobalRegistry, releasePorts } from '../../ports/index.ts';
import { readPids, readPidsOrNull, runningServices, stopServices } from '../../process/index.ts';
import { portlerDir } from '../../state/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import { pathExists } from '../../util/fs.ts';
import type { ParsedArgs } from '../args.ts';
import type { PidsFile } from '../../types/index.ts';

/**
 * Read pids.json for `clean`.
 *
 * Without --force, a corrupt file raises CorruptStateFileError, whose message
 * tells the user to run `clean --force` — so the error is actionable rather
 * than a bare SyntaxError.
 *
 * With --force it is treated as empty: `clean --force` is precisely the command
 * used to recover a broken `.portler/`, and it must not be blocked by the very
 * file it is about to delete. We cannot know which pids were recorded in an
 * unparseable file, so we say plainly that processes may be left behind.
 */
async function readPidsForClean(projectDir: string, force: boolean): Promise<PidsFile | null> {
  if (!force) return readPids(projectDir);

  const pidsFile = path.join(portlerDir(projectDir), 'pids.json');
  const existed = await pathExists(pidsFile);
  const pids = await readPidsOrNull(projectDir);

  if (existed && pids === null) {
    process.stderr.write(
      '[portler] warning: pids.json is unreadable, so the recorded pids are unknown; cleaning up state anyway. ' +
        'Any services it tracked are still running — check with "ps" and stop them yourself.\n',
    );
  }

  return pids;
}

/**
 * Clean up Portler state:
 * - default: remove the local `.portler/` runtime files and release this
 *   project's ports from the global registry
 * - --ports: only release this project's ports, keep `.portler/`
 * - --global: prune stale entries (crashed or deleted projects) from the
 *   global registry, without touching this project
 *
 * Refuses to touch a project with live services unless --force is given, in
 * which case the running services are stopped first.
 */
export async function commandClean(args: ParsedArgs): Promise<number> {
  if (args.positionals.length > 0) throw new Error('clean does not accept service names');
  if (args.global && !args.ports && args.file !== undefined) {
    throw new Error('--file does not apply to "portler clean --global" unless --ports also cleans the named project');
  }

  if (args.global) {
    const removed = await pruneGlobalRegistry(args.force);
    process.stdout.write(`[portler] pruned ${removed} stale ${removed === 1 ? 'entry' : 'entries'} from the global registry\n`);
    if (!args.ports) return 0;
  }

  const config = await loadConfig(process.cwd(), args.file);

  // Same lifecycle lock as up/down/restart: `clean` reads the running set and
  // then deletes the state it just read, which must not interleave with an `up`
  // recording a pid into that same state.
  return withLifecycleLock(config.projectDir, () => cleanProject(config.projectDir, args));
}

async function cleanProject(projectDir: string, args: ParsedArgs): Promise<number> {
  const pids = await readPidsForClean(projectDir, args.force);
  const running = runningServices(pids);

  if (running.length > 0 && !args.force) {
    throw new Error(`services are still running: ${running.join(', ')}. Run "portler down" first or pass --force to stop them.`);
  }

  // A dead supervisor does not prove its Docker container died with it. Always
  // process every surviving PID entry before deleting the only file that names
  // those resources, even when `runningServices` found no live leader.
  if (pids && Object.keys(pids.services).length > 0) {
    const result = await stopServices(projectDir, undefined, { force: args.force });
    if (result.stopped.length > 0) process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);

    const incomplete = result.unverified.length > 0 || result.failures.length > 0;
    if (incomplete && !args.force) {
      throw new Error(
        `clean could not finish stopping: ${[...result.unverified, ...result.failures].join('; ')}. ` +
          'Runtime state was kept; fix the cause and run "portler down" first, or use "portler clean --force" to discard it.',
      );
    }
    if (incomplete) {
      process.stderr.write(
        `[portler] warning: ${result.failures.length + result.unverified.length} resource(s) could not be cleaned up; ` +
          'the local state is still being removed because --force was specified. Check processes, "docker ps -a", and "docker network ls".\n',
      );
    }
  }

  await releasePorts(projectDir);
  process.stdout.write("[portler] released this project's ports from the global registry\n");

  if (!args.ports) {
    await fs.rm(portlerDir(projectDir), { recursive: true, force: true });
    process.stdout.write('[portler] removed .portler/ runtime files\n');
  }

  return 0;
}
