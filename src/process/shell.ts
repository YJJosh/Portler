import { spawn } from 'node:child_process';
import type { ChildProcess, StdioOptions } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { constants } from 'node:os';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';
import type { EnvMap } from '../types/index.ts';
import { processGroupAlive, processGroupAliveAfterKill } from './pids.ts';

export interface ShellOptions {
  /** Cancel this owned shell tree, with a bounded wait even if it ignores signals. */
  signal?: AbortSignal;
  /** Called with every signal that is forwarded to the command's process group. */
  onSignal?: (signal: NodeJS.Signals) => void;
  /** Ms to wait, at most, after the shell exits for the rest of its group, then kill what is left. Unset: no wait. */
  drainMs?: number;
  /** Relay output that goes to a pipe or socket through Portler, so the command survives a reader closing it. */
  relayOutput?: boolean;
}

// A pipe or socket can be closed by its reader (`| head`); a terminal, file or /dev/null cannot.
function closablePipe(fd: number): string | undefined {
  try {
    // macOS pipe inodes are kernel addresses, beyond a double's exact range.
    const stats = fstatSync(fd, { bigint: true });
    return stats.isFIFO() || stats.isSocket() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

interface RelayPlan {
  command: string;
  stdio: StdioOptions;
}

// A command writing to Portler's closed output gets SIGPIPE; through its own pipe, Portler drops the output instead.
// With `2>&1` both go into one pipe, so the order of stdout and stderr lines stays the same.
function relayPlan(command: string, relayOutput: boolean | undefined): RelayPlan {
  if (!relayOutput) return { command, stdio: 'inherit' };
  const out = closablePipe(1);
  const err = closablePipe(2);
  if (out !== undefined && out === err) return { command: `exec 2>&1\n${command}`, stdio: ['inherit', 'pipe', 'inherit'] };
  return { command, stdio: ['inherit', out ? 'pipe' : 'inherit', err ? 'pipe' : 'inherit'] };
}

// Waits for the reader, as an inherited pipe would. Node never emits 'drain' after a write error on stdout, so an
// error ends the wait and the rest is dropped.
function relay(from: Readable | null, to: NodeJS.WriteStream): Promise<void>[] {
  if (!from) return [];
  let gone = false;
  const resume = (): void => { from.resume(); };
  const drop = (): void => {
    gone = true;
    resume();
  };
  to.on('drain', resume);
  to.on('error', drop);
  from.on('data', (chunk: Buffer) => {
    if (!gone && !to.write(chunk)) from.pause();
  });
  return [new Promise((resolve) => from.once('close', () => {
    to.off('drain', resume);
    to.off('error', drop);
    resolve();
  }))];
}

// Waits briefly for the command's last output: something it left in the background can hold the pipe open, and
// must not keep Portler alive.
async function finishRelay(command: string, streams: readonly (Readable | null)[], closed: Promise<void>[]): Promise<void> {
  if (closed.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const drained = await Promise.race([
    Promise.all(closed).then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
  ]);
  clearTimeout(timer);
  if (drained) return;
  process.stderr.write(`[portler] "${command}" left a process that still holds its output; it may stop once Portler exits. Send that output to a file.\n`);
  for (const stream of streams) (stream as Socket | null)?.unref();
}

/** A foreground shell with inherited stdio (or relayed, see `relayOutput`), forwarding signals to its whole tree. */
export async function runShell(command: string, cwd: string, env: EnvMap, options: ShellOptions = {}): Promise<number> {
  options.signal?.throwIfAborted();
  // Handlers go in before spawn, or a signal during spawn kills Portler and leaves the command
  // running. They only run after this synchronous part, so `child` is set by then.
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
  // A startup controller already handles process signals: never forward one twice.
  if (!options.signal) {
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
  }
  try {
    const plan = relayPlan(command, options.relayOutput);
    const started = spawn(plan.command, { cwd, env, shell: true, detached: true, stdio: plan.stdio });
    child = started;
    const relayed = [...relay(started.stdout, process.stdout), ...relay(started.stderr, process.stderr)];
    const code = await new Promise<number>((resolve, reject) => {
      started.once('error', reject);
      started.once('exit', (exitCode, signal) => resolve(exitCode ?? (128 + (signal ? constants.signals[signal] : 1))));
    });
    await finishRelay(command, [started.stdout, started.stderr], relayed);
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
 * Only for a group this process spawned and still holds. Ignores ESRCH and EPERM (macOS: an
 * all-zombie group awaiting its reaper): a throw from a handler or timer would skip the rollback.
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
 * Only for a group this process spawned. What the shell backgrounded outlives it, so wait for the
 * group (a platform watching our pid must not cut the app off), then SIGKILL what is left.
 */
export async function drainOwnedProcessGroup(pgid: number, deadlineMs: number): Promise<void> {
  if (!groupAlive(pgid)) return;
  const deadline = Date.now() + deadlineMs;
  process.stderr.write(`[portler] waiting up to ${deadlineMs} ms for the rest of the process group to exit\n`);
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) {
      process.stderr.write('[portler] process group still running at the deadline; killing it\n');
      signalOwnedProcessGroup(pgid, 'SIGKILL');
      // SIGKILL is not instant, and a PID 1 that does not reap leaves zombies: confirm, warn if
      // it stays. The exit code stays the shell's.
      const confirmUntil = Date.now() + 2000;
      while (processGroupAliveAfterKill(pgid) && Date.now() < confirmUntil) await new Promise((resolve) => setTimeout(resolve, 50));
      if (processGroupAliveAfterKill(pgid)) process.stderr.write(`[portler] process group ${pgid} is still present after SIGKILL (unreaped?); giving up on it\n`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * In Portler's own group, so an interactive tool (psql, a REPL) gets Ctrl-C directly; Portler
 * ignores SIGINT and forwards SIGTERM/SIGHUP. Returns the exit status (128 + signal number when a signal ended it).
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
