/**
 * Ownership checks (Docker, kubectl) need exit code, stdout and stderr: a missing
 * container and an unreachable daemon both exit non-zero, and only the first means
 * "nothing to remove". Tests inject a CommandRunner instead of a real daemon.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { drainOwnedProcessGroup, signalOwnedProcessGroup } from '../process/shell.ts';

export interface CommandResult {
  /** Exit code; -1 when the binary could not be executed at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string, signal?: AbortSignal) => Promise<CommandResult>;

/**
 * On abort, signals the child's whole group, then SIGKILLs it after 2 s: a credential
 * helper can outlive kubectl, and a build helper must stop before rollback. The group
 * is ours: callers that pass a signal spawn the child as its leader and still hold it.
 * The returned cleanup keeps the SIGKILL armed until the group has drained.
 */
export function stopChildOnAbort(child: ChildProcess, signal?: AbortSignal): () => Promise<void> {
  if (!signal) return async () => {};
  const forward = (name: NodeJS.Signals): void => {
    if (child.pid) signalOwnedProcessGroup(child.pid, name);
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
      // A helper can close its pipes and keep running; rollback waits for it to stop.
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
        // The child may exit before reading stdin; the exit handler reports that.
      });
      child.stdin.end(input);
    }
  });
};
