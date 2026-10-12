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

export interface ForegroundWaitOptions {
  /**
   * Whether the services of other runs that the last teardown kept something
   * for are still alive. They are not this process's children, so nothing
   * reports their exit; while attached the supervisor asks this every
   * `recheckMs` and runs the teardown again once it says no.
   */
  dependentsAlive?: () => Promise<boolean>;
  recheckMs?: number;
}

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
 * exit (`portler down` from elsewhere), and a Ctrl-C then stops them too. Each
 * time one of them exits on its own, the teardown runs again, staying attached
 * to the ones still running: their entries still name this run, and only a
 * teardown prunes a dead one and gives its port back. The services of other
 * runs it kept them for are not children of this process, so it also polls
 * `dependentsAlive`, and runs the teardown again once they are gone: whatever
 * nothing depends on any more is then stopped. While a teardown is in
 * progress the signal handlers are off, so a second Ctrl-C still quits at once,
 * as it always has.
 */
export function waitForForegroundServices(
  children: Map<string, ChildProcess>,
  teardown: ForegroundTeardown,
  options: ForegroundWaitOptions = {},
): Promise<number> {
  let phase: 'running' | 'stopping' | 'attached' | 'done' = 'running';

  return new Promise<number>((resolve) => {
    let attachedNames: string[] = [];
    let announced = '';
    let triggerCode = 0;
    const exited = new Set<string>();

    const onSigint = (): void => onSignal('SIGINT', 130);
    const onSigterm = (): void => onSignal('SIGTERM', 143);
    const listen = (): void => {
      process.once('SIGINT', onSigint);
      process.once('SIGTERM', onSigterm);
    };
    let recheck: NodeJS.Timeout | undefined;
    const unlisten = (): void => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (recheck) clearInterval(recheck);
      recheck = undefined;
    };
    // Only while attached, and never two questions at once.
    const startRecheck = (): void => {
      const { dependentsAlive } = options;
      if (!dependentsAlive || recheck) return;
      let asking = false;
      recheck = setInterval(() => {
        if (asking || phase !== 'attached') return;
        asking = true;
        dependentsAlive().then(
          (alive) => {
            asking = false;
            if (!alive && phase === 'attached') void settle();
          },
          () => {
            asking = false;
          },
        );
      }, options.recheckMs ?? 2000);
      recheck.unref();
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

    // A kept service that exits while a pass runs was seen alive by that pass,
    // so its entry is still there: run again. Each repeat needs a new exit.
    const keepingPasses = async (): Promise<string[] | undefined> => {
      for (;;) {
        const before = new Set(exited);
        const kept = await runTeardown({ keepAdopted: true });
        if (kept === undefined) return undefined;
        if (!kept.some((serviceName) => exited.has(serviceName) && !before.has(serviceName))) return kept;
      }
    };

    const attachOrFinish = (kept: string[] | undefined): void => {
      if (kept === undefined) {
        finish(triggerCode === 0 ? 1 : triggerCode);
        return;
      }
      attachedNames = kept.filter((serviceName) => isRunning(children.get(serviceName)));
      if (attachedNames.length === 0) {
        finish(triggerCode);
        return;
      }

      phase = 'attached';
      const names = attachedNames.join(', ');
      if (names !== announced) {
        announced = names;
        const one = attachedNames.length === 1;
        process.stderr.write(
          `[portler] still attached to ${names}: another run depends on ${one ? 'it' : 'them'}, ` +
            `so ${one ? 'its' : 'their'} output continues here until ${one ? 'it stops' : 'they stop'} ` +
            `(portler down ${attachedNames.join(' ')}). Press Ctrl+C to stop ${one ? 'it' : 'them'} now.\n`,
        );
      }
      listen();
      startRecheck();
    };

    const cleanup = async (exitCode: number): Promise<void> => {
      if (phase !== 'running') return;
      phase = 'stopping';
      triggerCode = exitCode;
      unlisten();
      attachOrFinish(await keepingPasses());
    };

    // A kept service exited on its own, or what it was kept for is gone: run the
    // teardown again and stay with whatever it still keeps.
    const settle = async (): Promise<void> => {
      phase = 'stopping';
      unlisten();
      attachOrFinish(await keepingPasses());
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
        exited.add(serviceName);
        const exitCode = childExitCode(child.exitCode, child.signalCode);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
        continue;
      }

      child.once('exit', (code, signal) => {
        exited.add(serviceName);
        if (phase === 'attached' && attachedNames.includes(serviceName)) {
          void settle();
          return;
        }
        if (phase !== 'running') return;
        const exitCode = childExitCode(code, signal);
        process.stderr.write(`[portler] service "${serviceName}" exited with code ${exitCode}; stopping services...\n`);
        void cleanup(exitCode);
      });
    }
  });
}
