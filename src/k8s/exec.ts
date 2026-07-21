import { spawn } from 'node:child_process';
import { prefixStream } from '../process/index.ts';

export { runCommand } from '../util/exec.ts';
export type { CommandResult, CommandRunner } from '../util/exec.ts';

function commandLine(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/**
 * Run a command streaming its output with a `[prefix]` per line (like service
 * logs), rejecting when it exits non-zero.
 */
export function runStreaming(command: string, args: string[], prefix: string, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    if (child.stdout) prefixStream(prefix, child.stdout, process.stdout);
    if (child.stderr) prefixStream(prefix, child.stderr, process.stderr);

    child.on('error', (error) => reject(new Error(`failed to run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}`));
    });
  });
}

/** Run a command and capture its trimmed stdout, rejecting on non-zero exit. */
export function captureOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(new Error(`failed to run ${command}: ${error.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`command failed (exit ${code ?? 'signal'}): ${commandLine(command, args)}\n${stderr.trim()}`));
    });
  });
}

// runBestEffort() used to live here: it reported a failed kubectl delete as a
// boolean the caller then turned into a warning. Deletes now go through
// runCommand and propagate the real error, because "could not delete" must not
// end with `down` exiting 0 and releasing the ports.
