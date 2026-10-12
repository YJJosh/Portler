import type { ChildProcess } from 'node:child_process';

function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

/** What the supervisor asks of a foreground teardown. */
export interface ForegroundTeardownOptions {
  /**
   * Leave this run's services running while a service another run started
   * depends on them (the default). The stop that follows, once the user has been
   * told which services stayed up, passes false: Ctrl-C then stops them too.
   */
  keepAdopted?: boolean;
}

/**
 * Stop the run's services. Returns the names of this run's own services it left
 * running because another run depends on them; a teardown with nothing to
 * report may return nothing.
 */
export type ForegroundTeardown = (options?: ForegroundTeardownOptions) => Promise<string[] | void>;

/**
 * Supervise foreground services: on SIGINT/SIGTERM or the first child exit,
 * run `teardown` once and resolve with the resulting exit code.
 *
 * A teardown that throws (it now takes the project lifecycle lock, and it can
 * fail to stop something) must not leave this promise pending forever — the
 * process would hang with no output. Report it and exit non-zero instead.
 *
 * A teardown can leave some of this run's own children running because a
 * service another run started depends on them (`portler restart api` keeps the
 * db this run started). Their output is piped through this process, so it
 * cannot exit without cutting them off: it says so, keeps relaying until they
 * exit (`portler down` from elsewhere), and a Ctrl-C then stops them too. When
 * they exit on their own, the teardown runs once more before the wait resolves:
 * their entries still name this run, and only a teardown prunes a dead one and
 * gives its port back. While a teardown is in progress the signal handlers are
 * off, so a second Ctrl-C still quits at once, as it always has.
 */
export function waitForForegroundServices(
  children: Map<string, ChildProcess>,
  teardown: ForegroundTeardown,
): Promise<number> {
  let phase: 'running' | 'stopping' | 'attached' | 'done' = 'running';

  return new Promise<number>((resolve) => {
    let attachedNames: string[] = [];
    let triggerCode = 0;

    const onSigint = (): void => onSignal('SIGINT', 130);
    const onSigterm = (): void => onSignal('SIGTERM', 143);
    const listen = (): void => {
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
    };
    const unlisten = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    };

    const finish = (exitCode: number): void => {
      if (phase === 'done') return;
      phase = 'done';
      unlisten();
      resolve(exitCode);
    };

    const runTeardown = async (options: ForegroundTeardownOptions): Promise<string[] | undefined> => {
      try {
        return (await teardown(options)) ?? [];
      } catch (error) {
        process.stderr.write(`[portler] teardown failed: ${(error as Error).message}\n`);
        return undefined;
      }
    };

    const isRunning = (child: ChildProcess | undefined): boolean =>
      child !== undefined && child.exitCode === null && child.signalCode === null;

    const cleanup = async (exitCode: number): Promise<void> => {
      if (phase !== 'running') return;
      phase = 'stopping';
      triggerCode = exitCode;
      unlisten();

      const kept = await runTeardown({ keepAdopted: true });
      if (kept === undefined) {
        finish(exitCode === 0 ? 1 : exitCode);
        return;
      }
      attachedNames = kept.filter((serviceName) => isRunning(children.get(serviceName)));
      if (attachedNames.length === 0) {
        finish(exitCode);
        return;
      }

      phase = 'attached';
      const one = attachedNames.length === 1;
      process.stderr.write(
        `[portler] still attached to ${attachedNames.join(', ')}: another run depends on ${one ? 'it' : 'them'}, ` +
          `so ${one ? 'its' : 'their'} output continues here until ${one ? 'it stops' : 'they stop'} ` +
          `(portler down ${attachedNames.join(' ')}). Press Ctrl+C to stop ${one ? 'it' : 'them'} now.\n`,
      );
      let left = attachedNames.length;
      for (const serviceName of attachedNames) {
        children.get(serviceName)!.once('exit', () => {
          left -= 1;
          if (left === 0 && phase === 'attached') void settleAfterKept();
        });
      }
      listen();
    };

    const settleAfterKept = async (): Promise<void> => {
      phase = 'stopping';
      unlisten();
      const kept = await runTeardown({ keepAdopted: true });
      finish(kept === undefined && triggerCode === 0 ? 1 : triggerCode);
    };

    const onSignal = (signal: NodeJS.Signals, exitCode: number): void => {
      if (phase === 'running') {
        process.stderr.write(`[portler] received ${signal}, stopping services...\n`);
        void cleanup(exitCode);
        return;
      }
      if (phase !== 'attached') return;
      phase = 'stopping';
      unlisten();
      process.stderr.write(`[portler] received ${signal}, stopping ${attachedNames.join(', ')}...\n`);
      void runTeardown({ keepAdopted: false }).then(() => finish(exitCode));
    };

    listen();

    for (const [serviceName, child] of children) {
      if (!isRunning(child)) {
        const exitCode = childExitCode(child.exitCode, child.signalCode);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
        continue;
      }

      child.once('exit', (code, signal) => {
        if (phase !== 'running') return;
        const exitCode = childExitCode(code, signal);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
      });
    }
  });
}
