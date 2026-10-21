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

export interface CommandResult {
  /** Exit code; -1 when the binary could not be executed at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string, signal?: AbortSignal) => Promise<CommandResult>;

/**
 * REVIEW: share cancellation with the streaming k8s runner so namespace/ownership
 * reads can stop their own child too. No group is signalled: this ChildProcess is
 * the proof of ownership; exit cleanup disarms escalation and removes the listener.
 */
export function stopChildOnAbort(child: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  let killTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    child.kill(signal.reason === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  };
  signal.addEventListener('abort', abort, { once: true });
  return () => {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', abort);
  };
}

/** Run a command, capturing output. Failures are results; only cancellation rejects, after exit. */
export const runCommand: CommandRunner = (command, args, input, signal) => {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
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
      cleanup();
      rejectOrResolve({ code: -1, stdout: '', stderr: `failed to run ${command}: ${error.message}` });
    });
    child.on('exit', cleanup);
    child.on('close', (code) => rejectOrResolve({ code: code ?? 1, stdout, stderr }));

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
