import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { EnvMap } from '../types/index.ts';
import { processGroupAlive } from './pids.ts';

export interface ShellOptions {
  /** Called with every signal that is forwarded to the command's process group. */
  onSignal?: (signal: NodeJS.Signals) => void;
  /**
   * After the shell exits, wait up to this many milliseconds for the rest of
   * its process group to exit, then kill what is left. Without it the call
   * returns as soon as the shell does, whatever it left running.
   */
  drainMs?: number;
}

/** A foreground shell with inherited stdio, forwarding signals to its whole tree. */
export async function runShell(command: string, cwd: string, env: EnvMap, options: ShellOptions = {}): Promise<number> {
  const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    options.onSignal?.(signal);
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const interrupt = (): void => forward('SIGINT');
  const terminate = (): void => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve(exitCode ?? (128 + (signal ? constants.signals[signal] : 1))));
    });
    // Signals keep being forwarded while the rest of the group drains.
    if (options.drainMs !== undefined && child.pid) await drainGroup(child.pid, options.drainMs);
    return code;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

/** True while the group holds a process that can run; a zombie-only group is gone (see processGroupAlive). */
function groupAlive(pgid: number): boolean {
  return processGroupAlive(pgid);
}

/**
 * The shell is only the group's leader: a server it exec'd, or a process it
 * backgrounded, is still in the group after the shell exits, draining
 * connections on SIGTERM or not. Wait for the group to empty, with a deadline,
 * so a platform that watches our pid does not cut the app off the moment the
 * shell dies; what is still there at the deadline is killed.
 */
async function drainGroup(pgid: number, deadlineMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  const deadline = Date.now() + deadlineMs;
  process.stderr.write(`[portler] waiting up to ${deadlineMs} ms for the rest of the process group to exit\n`);
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      process.stderr.write('[portler] process group still running at the deadline; killing it\n');
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      // SIGKILL is not instant, and under a PID 1 that does not reap orphans a
      // killed member stays in the group as a zombie. Confirm the group is gone
      // before returning, and say so when it is not: the exit code stays the
      // shell's, since nothing more can be done to a process that survived SIGKILL.
      const confirmUntil = Date.now() + 2000;
      while (groupAlive(pgid) && Date.now() < confirmUntil) await new Promise((resolve) => setTimeout(resolve, 50));
      if (groupAlive(pgid)) process.stderr.write(`[portler] process group ${pgid} is still present after SIGKILL (unreaped?); giving up on it\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
