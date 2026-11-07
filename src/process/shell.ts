import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import type { EnvMap } from '../types/index.ts';
import { processGroupAlive, processGroupAliveAfterKill } from './pids.ts';

export interface ShellOptions {
  /** Cancel this owned shell tree, with a bounded wait even if it ignores signals. */
  signal?: AbortSignal;
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
  options.signal?.throwIfAborted();
  // REVIEW: handlers go in before spawn. Once the command runs, a signal can
  // arrive before spawn returns to this code, and with no handler yet it killed
  // Portler outright and left the command running. Handlers only run after this
  // synchronous part, so `child` is always set by then.
  let child: ChildProcess | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    options.onSignal?.(signal);
    if (child?.pid) signalOwnedProcessGroup(child.pid, signal);
  };
  const interrupt = (): void => forward('SIGINT');
  const terminate = (): void => forward('SIGTERM');
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    forward(options.signal?.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    // We still hold this child: cancellation may stop its whole process group.
    killTimer = setTimeout(() => forward('SIGKILL'), 2000);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  // A startup controller already handles process signals. Do not forward the
  // same signal twice (or send SIGTERM as well as SIGINT on a single Ctrl-C).
  if (!options.signal) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  try {
    const started = spawn(command, { cwd, env, shell: true, detached: true, stdio: 'inherit' });
    child = started;
    const code = await new Promise<number>((resolve, reject) => {
      started.once('error', reject);
      started.once('exit', (exitCode, signal) => resolve(exitCode ?? (128 + (signal ? constants.signals[signal] : 1))));
    });
    // Signals keep being forwarded while the rest of the group drains.
    const drainMs = options.signal?.aborted ? 2000 : options.drainMs;
    if (drainMs !== undefined && started.pid) await drainOwnedProcessGroup(started.pid, drainMs);
    return code;
  } finally {
    clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', abort);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

/**
 * Signal a process group this process spawned and still holds. A group that is gone is
 * fine, and so is EPERM: macOS returns it for a group whose members are all zombies
 * waiting for their reaper, which happens when a cancelled command's helper has just
 * been killed. A throw here would escape a signal handler, an abort listener or a timer
 * as an uncaught exception and end Portler before its rollback.
 */
export function signalOwnedProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
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
// Also drains cancelled startup commands (src/util/exec.ts), whose helpers can outlive
// kubectl or docker too. Call it only for a group this process spawned.
export async function drainOwnedProcessGroup(pgid: number, deadlineMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  const deadline = Date.now() + deadlineMs;
  process.stderr.write(`[portler] waiting up to ${deadlineMs} ms for the rest of the process group to exit\n`);
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      process.stderr.write('[portler] process group still running at the deadline; killing it\n');
      signalOwnedProcessGroup(pgid, 'SIGKILL');
      // SIGKILL is not instant, and under a PID 1 that does not reap orphans a
      // killed member stays in the group as a zombie. Confirm the group is gone
      // before returning, and say so when it is not: the exit code stays the
      // shell's, since nothing more can be done to a process that survived SIGKILL.
      // After SIGKILL no member can start another process, so one scan is exact.
      const confirmUntil = Date.now() + 2000;
      while (processGroupAliveAfterKill(pgid) && Date.now() < confirmUntil) await new Promise((resolve) => setTimeout(resolve, 50));
      if (processGroupAliveAfterKill(pgid)) process.stderr.write(`[portler] process group ${pgid} is still present after SIGKILL (unreaped?); giving up on it\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * A command in Portler's own process group, so it owns the terminal like any
 * command typed in a shell: an interactive tool (psql, a REPL) can read from
 * it, and Ctrl-C reaches it straight from the terminal. Portler ignores SIGINT
 * meanwhile, passes SIGTERM and SIGHUP on to the child it holds, and returns
 * the command's exit status (128 + signal number when a signal ended it).
 */
export async function runForeground(command: string, cwd: string, env: EnvMap): Promise<number> {
  // Handlers go in before spawn, for the same reason as in runShell.
  let child: ChildProcess | undefined;
  const ignore = (): void => {};
  const terminate = (): void => {
    child?.kill('SIGTERM');
  };
  const hangUp = (): void => {
    child?.kill('SIGHUP');
  };
  process.on('SIGINT', ignore);
  process.on('SIGTERM', terminate);
  process.on('SIGHUP', hangUp);
  try {
    const started = spawn(command, { cwd, env, shell: true, stdio: 'inherit' });
    child = started;
    return await new Promise<number>((resolve, reject) => {
      started.once('error', reject);
      started.once('exit', (exitCode, signal) => resolve(exitCode ?? (128 + (signal ? constants.signals[signal] : 1))));
    });
  } finally {
    process.off('SIGINT', ignore);
    process.off('SIGTERM', terminate);
    process.off('SIGHUP', hangUp);
  }
}
