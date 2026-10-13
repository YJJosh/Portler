import type { PidServiceInfo } from '../types/index.ts';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';
import { identityVerdict, readProcessStartToken } from './identity.ts';
import { ownedContainerLiveness } from './ownership.ts';
import { isPidAlive } from './pids.ts';

export type ServiceLiveness =
  /** The recorded pid is the process Portler started, or cannot be told apart from it. */
  | { status: 'running'; via: 'pid' }
  /** The pid is gone, but the Docker container it supervised runs on under this project's label. */
  | { status: 'running'; via: 'container' }
  | { status: 'dead' }
  /** The pid is gone and the container could not be inspected (daemon down, permission error). */
  | { status: 'unknown'; message: string };

/**
 * Whether a pids.json entry still names something alive. The pid first, by
 * identity: a live pid whose start token differs from the recorded one was
 * recycled by the OS for an unrelated process, so the entry is as dead as one
 * whose pid is gone or a zombie (under a PID 1 that does not reap orphans, an
 * exited service keeps its pid and start token). A live pid that cannot be
 * identified (no recorded token, or the platform will not say) counts as
 * running. Then, for a Docker service, its container: `docker run` is
 * supervised by a shell whose pid can be gone while the container runs on. A
 * failed inspect is reported as such, never guessed either way.
 */
export async function serviceLiveness(projectDir: string, info: PidServiceInfo, run: CommandRunner = runCommand): Promise<ServiceLiveness> {
  const exists = isPidAlive(info.pid);
  const verdict = identityVerdict(info.startToken, exists ? await readProcessStartToken(info.pid) : null, exists);
  if (verdict === 'match' || verdict === 'unverifiable') return { status: 'running', via: 'pid' };
  if (!info.dockerContainer) return { status: 'dead' };
  const container = await ownedContainerLiveness(info.dockerContainer, projectDir, run);
  if (container.status === 'running') return { status: 'running', via: 'container' };
  if (container.status === 'error') return { status: 'unknown', message: container.message };
  return { status: 'dead' };
}
