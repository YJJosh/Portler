import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { portlerDir } from '../state/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { isObject, isString } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import { clusterForContext, contextExists, detectCluster } from './cluster.ts';
import type { ClusterInfo } from './cluster.ts';
import { projectDeploymentNames } from './kubectl.ts';
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
  /** The kubeconfig `up k8s` read the context from (see kubeconfigInUse). */
  kubeconfig: string;
  recordedAt: string;
}

export function launchContextPath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'k8s-context.json');
}

function isLaunchContextFile(value: unknown): value is LaunchContextFile {
  return (
    isObject(value) &&
    value.version === 1 &&
    isString(value.project) &&
    isString(value.context) &&
    value.context !== '' &&
    isString(value.kubeconfig)
  );
}

function readLaunchRecord(projectDir: string): Promise<LaunchContextFile | null> {
  // A copied checkout may carry the source project's `.portler/`; never act on its cluster.
  return readValidatedJsonFile(
    launchContextPath(projectDir),
    'Portler Kubernetes context file',
    (value): value is LaunchContextFile => isLaunchContextFile(value) && value.project === projectDir,
  );
}

/** The recorded context, or null when no `up k8s` recorded one (or a full `down k8s` has since cleared it). */
export async function readLaunchContext(projectDir: string): Promise<string | null> {
  return (await readLaunchRecord(projectDir))?.context ?? null;
}

/**
 * The kubeconfig kubectl reads here: KUBECONFIG with each path made absolute (kubectl
 * resolves them against the working directory), or its default, ~/.kube/config. Symlinks
 * are resolved, so two spellings of one file (/tmp and /private/tmp on macOS) match.
 */
function kubeconfigInUse(): string {
  const paths = (process.env.KUBECONFIG ?? '').split(path.delimiter).filter((entry) => entry !== '');
  if (paths.length === 0) paths.push(path.join(os.homedir(), '.kube', 'config'));
  return paths.map((entry) => realPath(path.resolve(entry))).join(path.delimiter);
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * The error for a command reading another kubeconfig than `up k8s` did, or undefined.
 * A context name is only unique within its kubeconfig: the same name in another one (every
 * Docker Desktop has "docker-desktop") may be another cluster, so deleting there, or
 * replacing the record, could leave the real stack running.
 */
function differentKubeconfig(record: LaunchContextFile, refusal: string): Error | undefined {
  const here = kubeconfigInUse();
  if (record.kubeconfig === here) return undefined;
  return new Error(
    `kubectl context "${record.context}", where "portler up k8s" started this project, was recorded with a different kubeconfig ` +
      `(${here}); "portler up k8s" read it from ${record.kubeconfig}. ${refusal} Run this again with ` +
      `KUBECONFIG=${record.kubeconfig}. If that cluster is gone for good, "portler clean" forgets it, along with the ` +
      "rest of this checkout's runtime state.",
  );
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
  /** The recorded context is no longer in the kubeconfig `up k8s` read it from, so nothing can reach that cluster through it. */
  | { source: 'gone'; context: string };

/**
 * The cluster `env` and `down k8s` act on. A recorded context passes the same local-cluster
 * checks as the active one does, and a failure names it: it may not be the active one.
 */
export async function launchCluster(projectDir: string, run: CommandRunner = runCommand): Promise<LaunchCluster> {
  const record = await readLaunchRecord(projectDir);
  if (record === null) return { source: 'active', cluster: await detectCluster(run) };
  const error = differentKubeconfig(record, 'Portler will not assume an identically named context is the same cluster.');
  if (error) throw error;
  const { context } = record;
  if ((await contextExists(context, run)) === false) {
    return { source: 'gone', context };
  }
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
 * context with nothing deployed, or one the kubeconfig `up k8s` read no longer has, is
 * replaced.
 *
 * Returns a function that takes the record back, for a start whose teardown removed
 * everything it started: a stale record would make a later `up k8s` in another context or
 * kubeconfig refuse. It keeps a record an earlier `up k8s` wrote for this context, whose
 * services may still run there, and one a later `up k8s` has rewritten since.
 */
export async function recordLaunchContext(
  config: PortlerConfig,
  cluster: ClusterInfo,
  run: CommandRunner = runCommand,
): Promise<() => Promise<void>> {
  const record = await readLaunchRecord(config.projectDir);
  if (record !== null) {
    const error = differentKubeconfig(record, `Portler will not start it in "${cluster.context}" as well while it may still run there.`);
    if (error) throw error;
  }
  if (record !== null && record.context !== cluster.context) {
    const recorded = record.context;
    if ((await contextExists(recorded, run)) === false) {
      process.stderr.write(
        `[portler] kubectl context "${recorded}", where "portler up k8s" last started this project, no longer exists; ` +
          `starting in "${cluster.context}"\n`,
      );
    } else {
      let deployed: string[] | undefined;
      let reason = 'kubectl could not list its Deployments';
      try {
        deployed = await projectDeploymentNames(await clusterForContext(recorded, run), config, run);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
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
    kubeconfig: kubeconfigInUse(),
    recordedAt: new Date().toISOString(),
  };
  await writeJsonFile(launchContextPath(config.projectDir), file);

  if (record !== null && record.context === cluster.context) return async () => {};
  return async () => {
    // Best effort: a record left behind only makes later commands more careful.
    const current = await readLaunchRecord(config.projectDir).catch(() => null);
    if (current?.recordedAt === file.recordedAt) await forgetLaunchContext(config.projectDir);
  };
}
