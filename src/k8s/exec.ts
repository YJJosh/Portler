import { spawn } from 'node:child_process';
import { prefixStream } from '../process/index.ts';
import { stopChildOnAbort } from '../util/exec.ts';

export { runCommand } from '../util/exec.ts';
export type { CommandResult, CommandRunner } from '../util/exec.ts';

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/**
 * Stream output with a `[prefix]` per line; rejects on a non-zero exit. An aborted `signal` stops the process group and
 * rejects once it has exited, so a cancelled apply is over before a rollback deletes what it applied.
 */
export function runStreaming(command: string, args: string[], prefix: string, cwd?: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, detached: signal !== undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = stopChildOnAbort(child, signal);

    if (child.stdout) prefixStream(prefix, child.stdout, process.stdout);
    if (child.stderr) prefixStream(prefix, child.stderr, process.stderr);

    child.on('error', (error) => {
      void cleanup().then(() => reject(new Error(`failed to run ${command}: ${error.message}`)), reject);
    });
    child.on('close', (code) => {
      void cleanup().then(() => {
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0) resolve();
        else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}`));
      }, reject);
    });
  });
}

/** Trimmed stdout; rejects on a non-zero exit. `signal` as for runStreaming. */
export function captureOutput(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: signal !== undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    const cleanup = stopChildOnAbort(child, signal);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      void cleanup().then(() => reject(new Error(`failed to run ${command}: ${error.message}`)), reject);
    });
    child.on('close', (code) => {
      void cleanup().then(() => {
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0) resolve(stdout.trim());
        else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}\n${stderr.trim()}`));
      }, reject);
    });
  });
}
