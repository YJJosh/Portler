import type { ChildProcess } from 'node:child_process';

function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

/**
 * Supervise foreground services: on SIGINT/SIGTERM or the first child exit,
 * run `teardown` exactly once and resolve with the resulting exit code.
 *
 * A teardown that throws (it now takes the project lifecycle lock, and it can
 * fail to stop something) must not leave this promise pending forever — the
 * process would hang with no output. Report it and exit non-zero instead.
 */
export function waitForForegroundServices(
  children: Map<string, ChildProcess>,
  teardown: () => Promise<void>,
): Promise<number> {
  let cleaningUp = false;

  return new Promise<number>((resolve) => {
    const cleanup = async (exitCode: number): Promise<void> => {
      if (cleaningUp) return;
      cleaningUp = true;

      try {
        await teardown();
      } catch (error) {
        process.stderr.write(`[portler] teardown failed: ${(error as Error).message}\n`);
        resolve(exitCode === 0 ? 1 : exitCode);
        return;
      }

      resolve(exitCode);
    };

    const onSignal = (signal: NodeJS.Signals, exitCode: number): void => {
      process.stderr.write(`[portler] received ${signal}, stopping services...\n`);
      void cleanup(exitCode);
    };

    process.once('SIGINT', () => onSignal('SIGINT', 130));
    process.once('SIGTERM', () => onSignal('SIGTERM', 143));

    for (const [serviceName, child] of children) {
      if (child.exitCode !== null || child.signalCode !== null) {
        const exitCode = childExitCode(child.exitCode, child.signalCode);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
        continue;
      }

      child.once('exit', (code, signal) => {
        if (cleaningUp) return;
        const exitCode = childExitCode(code, signal);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
      });
    }
  });
}
