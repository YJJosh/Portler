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

// The context `up k8s` deployed to, so after a context switch `env` and `down k8s` still act on
// that cluster. Read and written under the lifecycle lock.
interface LaunchContextFile {
  version: 1;
  project: string;
  context: string;
  /** The namespace it deployed to: portler.yml or --file may name another one by now. */
  namespace: string;
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
    isString(value.namespace) &&
    value.namespace !== '' &&
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

/** Null when no `up k8s` recorded one, or a full `down k8s` cleared it. */
export async function readLaunchContext(projectDir: string): Promise<string | null> {
  return (await readLaunchRecord(projectDir))?.context ?? null;
}

// KUBECONFIG made absolute (kubectl resolves it against the cwd), or ~/.kube/config, with
// symlinks resolved (/tmp vs /private/tmp on macOS).
function kubeconfigInUse(): string {
  const configured = process.env.KUBECONFIG ?? '';
  const paths = configured.split(path.delimiter).filter((entry) => entry !== '');
  // As in kubectl, only an unset or empty KUBECONFIG loads the default; `KUBECONFIG=:` loads none.
  if (configured === '') paths.push(path.join(os.homedir(), '.kube', 'config'));
  return paths.map((entry) => realPath(path.resolve(entry))).join(path.delimiter);
}

function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

// A context name is unique only within its kubeconfig (every Docker Desktop has "docker-desktop").
function differentKubeconfig(record: LaunchContextFile, refusal: string): Error | undefined {
  const here = kubeconfigInUse();
  if (record.kubeconfig === here) return undefined;
  return new Error(
    `kubectl context "${record.context}", where "portler up k8s" started this project, comes from a different kubeconfig: ` +
      `"portler up k8s" read ${record.kubeconfig}, this command reads ${here}. ${refusal} Run this again with ` +
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
  /** Nothing recorded (no `up k8s` since the last full `down k8s`, or an older Portler): the active context. */
  | { source: 'active'; cluster: ClusterInfo }
  /** The recorded context is no longer in the kubeconfig `up k8s` read it from. */
  | { source: 'gone'; context: string };

/** The cluster `env` and `down k8s` act on. A recorded context passes the same local-cluster checks as an active one. */
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
 * Record `cluster` before `up k8s` touches it. Throws while Deployments may remain in another recorded context,
 * since `env` and `down k8s` reach only one. The undo keeps a record an earlier `up k8s` wrote or a later one rewrote.
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
        deployed = await projectDeploymentNames(await clusterForContext(recorded, run), config, run, record.namespace);
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
    namespace: config.k8sNamespace,
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
