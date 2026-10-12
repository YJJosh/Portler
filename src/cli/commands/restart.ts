import { applyImageOverrides, configForRunMode, loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { readPids, runningServices, stopServices } from '../../process/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, selectServiceNames, validateImageOverrideTargets } from '../services.ts';
import { startPhase } from './up.ts';

/**
 * Restart services: stop the requested services (all by default), then start
 * them again in the background. Ports are deliberately NOT released in
 * between, so allocateAssignments reclaims the previous registry
 * reservations and services keep their ports whenever they are still free.
 * Dependencies that are not running are started too; dependencies that are
 * still running are left untouched. `--prod` restarts with the production
 * overrides, exactly like `up --prod`. restart keeps the mode a service was
 * started in: a production service refuses a plain restart and a development
 * one refuses `restart --prod`, so a routine restart can neither flip a stack
 * to the other mode nor mix the two modes in one dependency graph. `--setup`
 * and `--no-setup` apply to the services it starts again, like `up`: a server
 * without the source toolchain restarts with `--no-setup`.
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
    // restart keeps the mode a service was started in. A service started with
    // --prod must not be relaunched in development mode by a routine restart
    // (its dev command, setup and env would replace the production ones
    // without a word), and a development service must not be relaunched with
    // --prod either: the dependencies this restart leaves running would stay
    // in development next to it. The check covers every service the restart
    // touches, the roots it stops and the running dependencies it skips, and
    // runs before anything is stopped. Switching modes is down and then up.
    // Entries without `prod` predate the field and count as development.
    const before = await readPids(rawConfig.projectDir);
    const running = before?.services ?? {};
    // A restart without names stops every recorded service, including ones no longer in
    // the config; they are part of the running stack and count for the check too. The
    // proxy's entry is Portler's own and carries no mode.
    const stopping = requested.length > 0 ? requestedRootNames : Object.keys(running).filter((name) => name !== PROXY_SERVICE_NAME);
    const involved = [...new Set([...expandAndOrderServices(rawConfig, requestedRootNames), ...stopping])].filter(
      (name) => Object.hasOwn(running, name),
    );
    const prodStarted = involved.filter((name) => running[name]?.prod === true);
    const devStarted = involved.filter((name) => running[name]?.prod !== true);
    if (!args.prod && prodStarted.length > 0) {
      throw new Error(
        `${prodStarted.join(', ')} ${prodStarted.length === 1 ? 'was' : 'were'} started with --prod, and restart keeps the ` +
          'mode a service was started in. Pass --prod to restart in production mode, or run "portler down" and then ' +
          '"portler up" to switch modes.',
      );
    }
    if (args.prod && devStarted.length > 0) {
      throw new Error(
        `${devStarted.join(', ')} ${devStarted.length === 1 ? 'was' : 'were'} started in development mode, and restart keeps ` +
          'the mode a service was started in. Run "portler down" and then "portler up --prod" to switch modes.',
      );
    }

    // The run mode is kept the same way. A service `up docker` started from its docker:
    // block is recorded with its container name; a plain restart would relaunch it as a
    // local process, and a local process must not come back as a container: command, env
    // and the addresses other services use all differ between the two. Services with a
    // top-level image/build run in Docker in both modes and never mismatch. Services no
    // longer in the config are only stopped, so they do not take part.
    const modeConfig = configForRunMode(rawConfig, mode);
    const inConfig = involved.filter((name) => Object.hasOwn(modeConfig.services, name));
    const containerToProcess = inConfig.filter(
      (name) => running[name]?.dockerContainer !== undefined && modeConfig.services[name]?.docker === undefined,
    );
    const processToContainer = inConfig.filter(
      (name) => running[name]?.dockerContainer === undefined && modeConfig.services[name]?.docker !== undefined,
    );
    const again = `${requested.length > 0 ? ` ${requested.join(' ')}` : ''}${args.prod ? ' --prod' : ''}`;
    if (containerToProcess.length > 0) {
      throw new Error(
        `${containerToProcess.join(', ')} ${containerToProcess.length === 1 ? 'is' : 'are'} running in Docker, and restart keeps ` +
          `the mode a service was started in. Run "portler restart docker${again}", or "portler down" and then ` +
          '"portler up" to switch modes.',
      );
    }
    if (processToContainer.length > 0) {
      throw new Error(
        `${processToContainer.join(', ')} ${processToContainer.length === 1 ? 'is' : 'are'} running as a local process, and ` +
          `restart keeps the mode a service was started in. Run "portler restart${again}" without "docker", or ` +
          '"portler down" and then "portler up docker" to switch modes.',
      );
    }

    // Check --image before anything is stopped. applyImageOverrides rejects an unknown
    // service or one that does not run in Docker in this mode, and a target this restart
    // leaves running would keep its old image. Either failure after the stop would leave
    // the requested services down with nothing restarted.
    if (args.images) {
      applyImageOverrides(configForRunMode(rawConfig, mode), args.images);
      const runningNow = new Set(runningServices(before));
      const stoppingNow = requested.length > 0 ? new Set(requestedRootNames) : runningNow;
      const starting = expandAndOrderServices(rawConfig, requestedRootNames).filter(
        (serviceName) => !runningNow.has(serviceName) || stoppingNow.has(serviceName),
      );
      validateImageOverrideTargets(args.images, starting, runningNow);
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

    await startPhase(rawConfig, mode, requestedRootNames, { detach: true, skipRunning: true, prod: args.prod, setup: args.setup, images: args.images });

    return 0;
  });
}
