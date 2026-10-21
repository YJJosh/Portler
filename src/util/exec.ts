/**
 * Capturing command runner used by the ownership checks (Docker and kubectl).
 *
 * Those checks decide whether Portler is allowed to destroy something, so they
 * need the exit code, stdout AND stderr — "it failed" is not enough: a missing
 * container and an unreachable daemon both exit non-zero, and only one of them
 * means "nothing to remove". Injecting a CommandRunner also lets the tests
 * assert the exact argv and drive the control flow without a real daemon.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { drainOwnedProcessGroup } from '../process/shell.ts';

export interface CommandResult {
  /** Exit code; -1 when the binary could not be executed at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string, signal?: AbortSignal) => Promise<CommandResult>;

/**
 * REVIEW: Cancel the whole owned command tree, not just kubectl/docker's leader. A
 * credential helper can keep the pipes open after kubectl exits, hanging `close`, and
 * build helpers must finish before rollback. Callers spawn a private process group
 * whenever they supply a signal; we still hold that child, so signalling it is safe.
 * Keep escalation armed until close AND the cancelled group has drained.
 */
export function stopChildOnAbort(child: ChildProcess, signal?: AbortSignal): () => Promise<void> {
  if (!signal) return async () => {};
  const forward = (name: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    forward(signal.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    killTimer = setTimeout(() => forward('SIGKILL'), 2_000);
  };
  signal.addEventListener('abort', abort, { once: true });
  return async () => {
    signal.removeEventListener('abort', abort);
    try {
      // A helper may close its inherited pipes yet keep running. Do not finish a
      // cancelled command (and begin rollback) until those group members stop too.
      if (signal.aborted && child.pid) await drainOwnedProcessGroup(child.pid, 2_000);
    } finally {
      clearTimeout(killTimer);
    }
  };
}

/** Run a command, capturing output. Failures are results; only cancellation rejects, after exit. */
export const runCommand: CommandRunner = (command, args, input, signal) => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: signal !== undefined, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    const cleanup = stopChildOnAbort(child, signal);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      void cleanup().then(
        () => rejectOrResolve({ code: -1, stdout: '', stderr: `failed to run ${command}: ${error.message}` }),
        reject,
      );
    });
    child.on('close', (code) => {
      void cleanup().then(() => rejectOrResolve({ code: code ?? 1, stdout, stderr }), reject);
    });

    function rejectOrResolve(result: CommandResult): void {
      if (signal?.aborted) reject(signal.reason);
      else resolve(result);
    }

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The child may exit before reading stdin (e.g. binary not found);
        // the exit path above already reports that.
      });
      child.stdin.end(input);
    }
  });
};
