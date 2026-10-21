import fs from 'node:fs/promises';
import path from 'node:path';
import { portlerDir } from '../state/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { isObject, isString } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import { clusterForContext, contextExists, detectCluster } from './cluster.ts';
import type { ClusterInfo } from './cluster.ts';
import { deployedK8sServices } from './kubectl.ts';
import type { PortlerConfig } from '../types/index.ts';

/**
 * The kubectl context `up k8s` deployed this project to. Without it, a later `env` or
 * `down k8s` could only ask the context that is active by then: after a context switch,
 * `env` would not find a portless service where it runs, and `down k8s` would delete in
 * the other cluster. Read and written under the lifecycle lock.
 */
interface LaunchContextFile {
  version: 1;
  project: string;
  context: string;
  recordedAt: string;
}

export function launchContextPath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'k8s-context.json');
}

function isLaunchContextFile(value: unknown): value is LaunchContextFile {
  return isObject(value) && value.version === 1 && isString(value.project) && isString(value.context) && value.context !== '';
}

/** The recorded context, or null when no `up k8s` recorded one (or a full `down k8s` has since cleared it). */
export async function readLaunchContext(projectDir: string): Promise<string | null> {
  // A copied checkout may carry the source project's `.portler/`; never act on its cluster.
  const file = await readValidatedJsonFile(
    launchContextPath(projectDir),
    'Portler Kubernetes context file',
    (value): value is LaunchContextFile => isLaunchContextFile(value) && value.project === projectDir,
  );
  return file?.context ?? null;
}

export async function forgetLaunchContext(projectDir: string): Promise<void> {
  await fs.rm(launchContextPath(projectDir), { force: true });
}

/** Where this project's Kubernetes services run, as far as Portler can tell. */
export type LaunchCluster =
  /** The context `up k8s` recorded, checked like an active one. */
  | { source: 'recorded'; cluster: ClusterInfo }
  /** Nothing recorded (no `up k8s` since the last full `down k8s`, or one from an older Portler): the active context. */
  | { source: 'active'; cluster: ClusterInfo }
  /** The recorded context is no longer in the kubeconfig, so nothing can reach that cluster through it. */
  | { source: 'gone'; context: string };

/**
 * The cluster `env` and `down k8s` act on. A recorded context passes the same local-cluster
 * checks as the active one does, and a failure names it: it may not be the active one.
 */
export async function launchCluster(projectDir: string, run: CommandRunner = runCommand): Promise<LaunchCluster> {
  const context = await readLaunchContext(projectDir);
  if (context === null) return { source: 'active', cluster: await detectCluster(run) };
  if ((await contextExists(context, run)) === false) return { source: 'gone', context };
  try {
    return { source: 'recorded', cluster: await clusterForContext(context, run) };
  } catch (error) {
    throw new Error(`could not use kubectl context "${context}", where "portler up k8s" started this project: ${(error as Error).message}`);
  }
}

/**
 * Record `cluster` as where this project runs, before `up k8s` touches it. A project runs
 * in one cluster at a time: while it still has Deployments in another recorded context,
 * refuse, since `env` and `down k8s` could then only reach one of the two. A recorded
 * context with nothing deployed, or one the kubeconfig no longer has, is replaced.
 */
export async function recordLaunchContext(
  config: PortlerConfig,
  cluster: ClusterInfo,
  run: CommandRunner = runCommand,
): Promise<void> {
  const recorded = await readLaunchContext(config.projectDir);
  if (recorded !== null && recorded !== cluster.context) {
    if ((await contextExists(recorded, run)) === false) {
      process.stderr.write(
        `[portler] kubectl context "${recorded}", where "portler up k8s" last started this project, no longer exists; ` +
          `starting in "${cluster.context}"\n`,
      );
    } else {
      let deployed: string[] | undefined;
      let reason = 'kubectl could not list its Deployments';
      try {
        deployed = await deployedK8sServices(await clusterForContext(recorded, run), config, run);
      } catch (error) {
        reason = (error as Error).message;
      }
      const switchBack = `or switch back with "kubectl config use-context ${recorded}"`;
      if (deployed === undefined) {
        throw new Error(
          `"portler up k8s" started this project in kubectl context "${recorded}", and Portler could not ask that cluster ` +
            `whether it still runs there (${reason}), so it will not start it in "${cluster.context}" as well. Make ` +
            `"${recorded}" reachable and run "portler down k8s" (it acts on "${recorded}"), ${switchBack}. If that ` +
            'cluster is gone for good, "portler clean" forgets it, along with the rest of this checkout\'s runtime state.',
        );
      }
      if (deployed.length > 0) {
        throw new Error(
          `this project still runs in kubectl context "${recorded}" (${deployed.join(', ')}), where "portler up k8s" ` +
            `started it, and the active context is "${cluster.context}". Run "portler down k8s" to stop it there first ` +
            `(it acts on "${recorded}"), ${switchBack}.`,
        );
      }
    }
  }

  const file: LaunchContextFile = {
    version: 1,
    project: config.projectDir,
    context: cluster.context,
    recordedAt: new Date().toISOString(),
  };
  await writeJsonFile(launchContextPath(config.projectDir), file);
}
