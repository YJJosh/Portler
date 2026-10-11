import { loadConfig } from '../../config/index.ts';
import { readPids, stopServices } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import { parseRunMode, selectServiceNames } from '../services.ts';
import { startPhase } from './up.ts';

/**
 * Restart services: stop the requested services (all by default), then start
 * them again in the background. Ports are deliberately NOT released in
 * between, so allocateAssignments reclaims the previous registry
 * reservations and services keep their ports whenever they are still free.
 * Dependencies that are not running are started too; dependencies that are
 * still running are left untouched. `--prod` restarts with the production
 * overrides, exactly like `up --prod`; a service that was started with
 * `--prod` refuses a plain restart so a routine restart cannot flip a
 * production stack back to development.
 */
export async function commandRestart(args: ParsedArgs): Promise<number> {
  const rawConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });
  const { mode, requested } = parseRunMode(args.positionals);

  // `restart k8s` used to be accepted and then quietly do the wrong thing: it
  // applied the k8s config overlay (k8s.env, in-cluster DNS hostnames) but ran
  // the services as LOCAL processes, because only `up` routes k8s mode to
  // commandUpK8s. Nothing was ever applied to the cluster. Reject it instead of
  // guessing which half the user meant.
  if (mode === 'k8s') {
    throw new Error(
      'restart does not support Kubernetes mode. Run "portler down k8s" followed by "portler up k8s" instead ' +
        '(a k8s restart has to re-apply manifests and re-establish port-forwards, which restart does not do).',
    );
  }

  const requestedRootNames = selectServiceNames(rawConfig, requested);

  // Stop and start under ONE lifecycle lock. Taking it twice (once per half)
  // would leave a window in which another `portler up` sees the services as
  // stopped and starts them itself, and this restart then starts them again.
  // restart always detaches, so the lock is released as soon as startup is done.
  return withLifecycleLock(rawConfig.projectDir, async () => {
    // A service started with --prod must not be relaunched in development mode
    // by a routine restart: its dev command, setup and env would replace the
    // production ones without a word. Checked before anything is stopped.
    const before = await readPids(rawConfig.projectDir);
    const stopping = requested.length > 0 ? requestedRootNames : Object.keys(before?.services ?? {});
    const prodStarted = stopping.filter((name) => before?.services[name]?.prod === true);
    if (!args.prod && prodStarted.length > 0) {
      throw new Error(
        `${prodStarted.join(', ')} ${prodStarted.length === 1 ? 'was' : 'were'} started with --prod; a plain restart would ` +
          'relaunch in development mode. Pass --prod to restart in production mode, or run "portler down" and then ' +
          '"portler up" to switch modes.',
      );
    }

    // With no names, stop everything in pids.json (like `portler down`) so
    // services removed from the config do not linger; otherwise stop only the
    // requested roots.
    const result = await stopServices(rawConfig.projectDir, requested.length > 0 ? requestedRootNames : undefined);
    if (result.stopped.length > 0) {
      process.stdout.write(`[portler] stopped: ${result.stopped.join(', ')}\n`);
    }

    // A service that was not confirmed stopped is still running and still
    // holding its port — whether Portler refused to signal it (identity) or the
    // teardown failed outright. Starting a second copy on top of it would be
    // worse than refusing: the user is told to deal with it, exactly as `down`
    // does.
    if (result.unverified.length > 0 || result.failures.length > 0) {
      const stuck = [...result.unverified, ...result.failures];
      throw new Error(
        `restart could not stop: ${stuck.join('; ')} — those services are (or may still be) running, so restart will ` +
          'not start a second copy on top of them. Stop them yourself: check each pid with ' +
          '"ps -o pid,ppid,lstart,command -p <pid>" and, once you have confirmed it is your service, stop it ' +
          '("kill -TERM -<pid>" signals its whole process group), then re-run restart.',
      );
    }

    await startPhase(rawConfig, mode, requestedRootNames, { detach: true, skipRunning: true, prod: args.prod });

    return 0;
  });
}
