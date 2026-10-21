import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { prefixStream } from '../process/index.ts';

export { runCommand } from '../util/exec.ts';
export type { CommandResult, CommandRunner } from '../util/exec.ts';

/** How long a cancelled command may take to exit before it is killed. */
const CANCEL_GRACE_MS = 2_000;

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/**
 * Stop the child when `signal` aborts: we spawned it and still hold it, so it may be
 * signalled (only it, not a process group). It gets the original signal first, as a
 * Ctrl-C in the terminal would give it, then SIGKILL if it has not exited after the
 * grace period. Returns the cleanup to run once it exits.
 */
function stopOnAbort(child: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill(signal.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), CANCEL_GRACE_MS);
  };
  signal.addEventListener('abort', abort, { once: true });
  return () => {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', abort);
  };
}

/**
 * Run a command streaming its output with a `[prefix]` per line (like service
 * logs), rejecting when it exits non-zero. An aborted `signal` stops it, and the
 * promise rejects with the signal's reason once it has exited: a cancelled apply must
 * be over before a rollback deletes what it applied.
 */
export function runStreaming(command: string, args: string[], prefix: string, cwd?: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = stopOnAbort(child, signal);

    if (child.stdout) prefixStream(prefix, child.stdout, process.stdout);
    if (child.stderr) prefixStream(prefix, child.stderr, process.stderr);

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`failed to run ${command}: ${error.message}`));
    });
    child.on('exit', (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}`));
    });
  });
}

/** Run a command and capture its trimmed stdout, rejecting on non-zero exit. `signal` as for runStreaming. */
export function captureOutput(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = stopOnAbort(child, signal);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      cleanup();
      reject(new Error(`failed to run ${command}: ${error.message}`));
    });
    child.on('exit', (code) => {
      cleanup();
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve(stdout.trim());
      else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}\n${stderr.trim()}`));
    });
  });
}

// runBestEffort() used to live here: it reported a failed kubectl delete as a
// boolean the caller then turned into a warning. Deletes now go through
// runCommand and propagate the real error, because "could not delete" must not
// end with `down` exiting 0 and releasing the ports.
