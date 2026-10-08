import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { EnvMap } from '../types/index.ts';

/** A foreground shell with inherited stdio, forwarding signals to its whole tree. */
export async function runShell(command: string, cwd: string, env: EnvMap): Promise<number> {
  const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: 'inherit' });
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const interrupt = (): void => forward('SIGINT');
  const terminate = (): void => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (128 + (signal ? constants.signals[signal] : 1))));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
