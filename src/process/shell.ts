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
   * After the shell exits, wait up to this many ms for the rest of its process
   * group, then kill what is left. Unset: return as soon as the shell exits.
   */
  drainMs?: number;
}

/** A foreground shell with inherited stdio, forwarding signals to its whole tree. */
export async function runShell(command: string, cwd: string, env: EnvMap, options: ShellOptions = {}): Promise<number> {
  options.signal?.throwIfAborted();
  // Handlers go in before spawn: a signal arriving before spawn returns would
  // otherwise kill Portler and leave the command running. They only run after
  // this synchronous part, so `child` is set by then.
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
    // This process still holds the child, so it may stop the whole group.
    killTimer = setTimeout(() => forward('SIGKILL'), 2000);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  // A startup controller already handles process signals: never forward one
  // twice (or SIGTERM as well as SIGINT on one Ctrl-C).
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
 * Only for a group this process spawned and still holds. ESRCH and EPERM are
 * ignored: macOS returns EPERM for an all-zombie group awaiting its reaper, and a
 * throw from a signal handler, abort listener or timer would end Portler before
 * its rollback.
 */
export function signalOwnedProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

function groupAlive(pgid: number): boolean {
  return processGroupAlive(pgid);
}

/**
 * The shell only leads the group: what it exec'd or backgrounded stays after it
 * exits. Waits for the group to empty, so a platform watching our pid does not
 * cut the app off when the shell dies, then SIGKILLs what is left. Also drains
 * cancelled startup commands (src/util/exec.ts). Only for a group this process
 * spawned.
 */
export async function drainOwnedProcessGroup(pgid: number, deadlineMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  const deadline = Date.now() + deadlineMs;
  process.stderr.write(`[portler] waiting up to ${deadlineMs} ms for the rest of the process group to exit\n`);
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      process.stderr.write('[portler] process group still running at the deadline; killing it\n');
      signalOwnedProcessGroup(pgid, 'SIGKILL');
      // SIGKILL is not instant, and under a PID 1 that does not reap orphans a
      // member stays a zombie. Confirm, and warn if it stays; the exit code stays
      // the shell's.
      const confirmUntil = Date.now() + 2000;
      while (processGroupAliveAfterKill(pgid) && Date.now() < confirmUntil) await new Promise((resolve) => setTimeout(resolve, 50));
      if (processGroupAliveAfterKill(pgid)) process.stderr.write(`[portler] process group ${pgid} is still present after SIGKILL (unreaped?); giving up on it\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Runs in Portler's own process group, so an interactive tool (psql, a REPL) owns
 * the terminal and gets Ctrl-C directly. Portler ignores SIGINT meanwhile and
 * forwards SIGTERM and SIGHUP. Returns the exit status (128 + signal number when
 * a signal ended it).
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
