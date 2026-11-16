import type { ChildProcess } from 'node:child_process';

function childExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code;
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

export interface ForegroundTeardownOptions {
  /**
   * Default true: leave this run's services up while a service of another run
   * depends on them. The stop after the user is told which stayed up passes false.
   */
  keepAdopted?: boolean;
}

/** Returns this run's services it left running because another run depends on them. */
export type ForegroundTeardown = (options?: ForegroundTeardownOptions) => Promise<string[] | void>;

export interface ForegroundWaitOptions {
  /**
   * Whether the other runs' services the last teardown kept something for are
   * all alive. They are not our children, so while attached this is polled every
   * `recheckMs` (default 2000) and a no runs the teardown again.
   */
  dependentsAlive?: () => Promise<boolean>;
  recheckMs?: number;
}

/**
 * On SIGINT/SIGTERM or the first child exit, runs `teardown` and resolves with
 * the exit code; a throwing teardown is reported and exits non-zero instead of
 * hanging. Children kept for another run stay attached (their output is piped
 * here) until they exit or Ctrl-C stops them. Each exit of one, or a
 * `dependentsAlive` no, runs the teardown again: only a teardown prunes an entry
 * and frees its port. Handlers are off during a teardown, so a second Ctrl-C
 * quits at once.
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
