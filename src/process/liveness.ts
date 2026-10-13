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
 * Whether a pids.json entry still names something alive. The pid first, by
 * identity: a live pid whose start token differs from the recorded one was
 * recycled by the OS for an unrelated process, so the entry is as dead as one
 * whose pid and group are gone (under a PID 1 that does not reap orphans, an
 * exited service keeps its pid and start token). A surviving group without a
 * leader is conservatively running, not proof of ownership. A live pid that cannot be
 * identified (no recorded token, or the platform will not say) counts as
 * running. Then, for a Docker service, its container: `docker run` is
 * supervised by a shell whose pid can be gone while the container runs on. A
 * failed inspect is reported as such, never guessed either way.
 */
export async function serviceLiveness(projectDir: string, info: PidServiceInfo, run: CommandRunner = runCommand): Promise<ServiceLiveness> {
  const exists = isPidAlive(info.pid);
  const verdict = identityVerdict(info.startToken, exists ? await readProcessStartToken(info.pid) : null, exists);
  if (verdict === 'match' || verdict === 'unverifiable') return { status: 'running', via: 'pid' };
  // A vanished leader is not a vanished service: keep unproven surviving
  // groups tracked, without granting permission to signal them. A mismatched
  // start token positively identifies a replacement, so its group is not ours.
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
 * The services in pids.json that are running by serviceLiveness: by pid, group, or the
 * Docker container a gone `docker run` shell left running. One whose container cannot
 * be inspected counts as running too: starting it again would remove that container if
 * it is up. `onUncertain` hears about failed inspections and unverified groups.
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
