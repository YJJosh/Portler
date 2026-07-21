/**
 * Capturing command runner used by the ownership checks (Docker and kubectl).
 *
 * Those checks decide whether Portler is allowed to destroy something, so they
 * need the exit code, stdout AND stderr — "it failed" is not enough: a missing
 * container and an unreachable daemon both exit non-zero, and only one of them
 * means "nothing to remove". Injecting a CommandRunner also lets the tests
 * assert the exact argv and drive the control flow without a real daemon.
 */
import { spawn } from 'node:child_process';

export interface CommandResult {
  /** Exit code; -1 when the binary could not be executed at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], input?: string) => Promise<CommandResult>;

/** Run a command, capturing its output. Never rejects — failures come back as a result. */
export const runCommand: CommandRunner = (command, args, input) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: `failed to run ${command}: ${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The child may exit before reading stdin (e.g. binary not found);
        // the exit path above already reports that.
      });
      child.stdin.end(input);
    }
  });
};
