import type { PidServiceInfo, PidsFile } from '../types/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { identityVerdict, readProcessStartToken } from './identity.ts';
import { ownedContainerLiveness } from './ownership.ts';
import { isPidAlive, processGroupAlive } from './pids.ts';

export type ServiceLiveness =
  /** The recorded pid is the process Portler started, or cannot be told apart from it. */
  | { status: 'running'; via: 'pid' }
  /** The pid is gone, but the Docker container it supervised runs on under this project's label. */
  | { status: 'running'; via: 'container' }
  /** The leader is gone, but its group still exists; identity is not proven. */
  | { status: 'running'; via: 'group'; message: string }
  | { status: 'dead' }
  /** The pid is gone and the container could not be inspected (daemon down, permission error). */
  | { status: 'unknown'; message: string };

/**
 * A live pid with a different start token was recycled, so the entry is dead. An
 * unidentifiable live pid counts as running, and so does a group that outlived
 * its leader, without being proven ours. A Docker container can run on after its
 * `docker run` shell is gone; a failed inspect is reported, never guessed.
 */
export async function serviceLiveness(projectDir: string, info: PidServiceInfo, run: CommandRunner = runCommand): Promise<ServiceLiveness> {
  const exists = isPidAlive(info.pid);
  const verdict = identityVerdict(info.startToken, exists ? await readProcessStartToken(info.pid) : null, exists);
  if (verdict === 'match' || verdict === 'unverifiable') return { status: 'running', via: 'pid' };
  // Track a surviving group without permission to signal it. A mismatched token
  // identifies a replacement, whose group is not ours.
  if (verdict === 'gone' && processGroupAlive(info.pid)) {
    return { status: 'running', via: 'group', message: `leader PID ${info.pid} is gone but its process group still exists; ownership cannot be verified` };
  }
  if (!info.dockerContainer) return { status: 'dead' };
  const container = await ownedContainerLiveness(info.dockerContainer, projectDir, run);
  if (container.status === 'running') return { status: 'running', via: 'container' };
  if (container.status === 'error') return { status: 'unknown', message: container.message };
  return { status: 'dead' };
}

/**
 * Services running by serviceLiveness. One whose container cannot be inspected
 * counts as running: starting it again would remove that container if it is up.
 * `onUncertain` hears about failed inspections and unverified groups.
 */
export async function liveServiceNames(
  projectDir: string,
  pids: PidsFile | null,
  onUncertain?: (serviceName: string, message: string) => void,
  run: CommandRunner = runCommand,
): Promise<string[]> {
  if (!pids) return [];
  const entries = Object.entries(pids.services);
  const liveness = await Promise.all(entries.map(([, info]) => serviceLiveness(projectDir, info, run)));
  const names: string[] = [];
  entries.forEach(([serviceName], index) => {
    const result = liveness[index];
    if (result.status === 'dead') return;
    if (result.status === 'unknown') onUncertain?.(serviceName, `could not inspect container "${pids.services[serviceName]!.dockerContainer}" (${result.message})`);
    if (result.status === 'running' && result.via === 'group') onUncertain?.(serviceName, result.message);
    names.push(serviceName);
  });
  return names;
}
