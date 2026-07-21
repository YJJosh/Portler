import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { resolveServiceCwd } from '../config/index.ts';
import { portlerDir } from '../state/index.ts';
import { withProjectLock } from '../state/lock.ts';
import { isObject, isOptionalPort, isOptionalString, isPositiveInteger, isString } from '../util/guards.ts';
import { readValidatedJsonFile, readValidatedJsonFileOrNull, writeJsonFile } from '../util/json-file.ts';
import { readProcessStartToken } from './identity.ts';
import type { PidsFile, PidServiceInfo, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

function isPidServiceInfo(value: unknown): value is PidServiceInfo {
  return (
    isObject(value) &&
    isPositiveInteger(value.pid) &&
    isString(value.command) &&
    isString(value.cwd) &&
    isOptionalPort(value.port) &&
    isOptionalString(value.url) &&
    isOptionalString(value.dockerContainer) &&
    isOptionalString(value.dockerNetwork) &&
    isOptionalString(value.startToken) &&
    isString(value.startedAt)
  );
}

function isPidsFile(value: unknown): value is PidsFile {
  return (
    isObject(value) &&
    value.version === 1 &&
    isString(value.project) &&
    isString(value.startedAt) &&
    isObject(value.services) &&
    Object.values(value.services).every(isPidServiceInfo)
  );
}

export function pidsPath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'pids.json');
}

function belongsToProject(value: unknown, projectDir: string): value is PidsFile {
  return isPidsFile(value) && value.project === projectDir;
}

export async function readPids(projectDir: string): Promise<PidsFile | null> {
  // Copying a checkout can copy `.portler/pids.json` too. A matching start token
  // proves that the recorded process still exists, but not that the NEW checkout
  // owns it; accepting a file whose `project` differs would let `down` in the copy
  // kill the original checkout's live process group.
  return readValidatedJsonFile(
    pidsPath(projectDir),
    'Portler PID file',
    (value): value is PidsFile => belongsToProject(value, projectDir),
  );
}

/** Read the PID file, treating a corrupt/mismatched one as absent (recovery paths only). */
export async function readPidsOrNull(projectDir: string): Promise<PidsFile | null> {
  return readValidatedJsonFileOrNull(
    pidsPath(projectDir),
    'Portler PID file',
    (value): value is PidsFile => belongsToProject(value, projectDir),
  );
}

export async function writePids(projectDir: string, pids: PidsFile): Promise<void> {
  await writeJsonFile(pidsPath(projectDir), pids);
}

/**
 * Read-modify-write the PID file under the project lock, so concurrent Portler
 * invocations in the same project cannot clobber each other's entries (a lost
 * write here orphans a running process: `down` never learns its pid).
 * The file is removed entirely once no services remain.
 *
 * The read is STRICT: a corrupt pids.json throws instead of being treated as an
 * empty file. Treating it as empty here would have `portler up` overwrite the
 * only record of the pids it cannot parse, orphaning those processes for good.
 * Only the explicit recovery paths (`clean --force`) may ignore corruption, and
 * they say out loud that processes may be left behind.
 */
export async function updatePids(projectDir: string, mutate: (pids: PidsFile) => void): Promise<void> {
  await withProjectLock(projectDir, async () => {
    const pids: PidsFile = (await readPids(projectDir)) ?? {
      version: 1,
      project: projectDir,
      startedAt: new Date().toISOString(),
      services: {},
    };

    mutate(pids);

    if (Object.keys(pids.services).length === 0) {
      await fs.rm(pidsPath(projectDir), { force: true });
      return;
    }

    await writePids(projectDir, pids);
  });
}

export async function removePidEntries(projectDir: string, serviceNames?: string[]): Promise<void> {
  if (!serviceNames) {
    await withProjectLock(projectDir, async () => {
      await fs.rm(pidsPath(projectDir), { force: true });
    });
    return;
  }

  await updatePids(projectDir, (pids) => {
    for (const serviceName of serviceNames) delete pids.services[serviceName];
  });
}

/**
 * Whether a process with this pid EXISTS. EPERM counts as existing: the pid is
 * held by a process we may not signal (another user's — e.g. one that recycled
 * the number). Reporting it as "not running" would be the dangerous direction,
 * since callers use this to decide whether an entry is stale.
 */
export function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runningServices(pids: PidsFile | null, serviceNames?: string[]): string[] {
  if (!pids) return [];
  const serviceSet = serviceNames ? new Set(serviceNames) : null;
  const running: string[] = [];

  for (const [serviceName, info] of Object.entries(pids.services)) {
    if (serviceSet && !serviceSet.has(serviceName)) continue;
    if (isPidRunning(info.pid)) running.push(serviceName);
  }

  return running;
}

/**
 * Build the PID-file record describing a freshly spawned service, capturing the
 * process's start token so a later `down` can prove the pid still refers to
 * this process and not to something the OS recycled the number onto.
 */
export async function pidInfoFor(
  config: PortlerConfig,
  service: ServiceConfig,
  child: ChildProcess,
  assignment: ServiceAssignment | undefined,
): Promise<PidServiceInfo> {
  if (child.pid === undefined) {
    throw new Error(`service "${service.name}" did not start with a process id`);
  }

  return {
    pid: child.pid,
    command: service.docker ? `docker run ${service.docker.image}` : (service.command ?? ''),
    cwd: resolveServiceCwd(config, service),
    port: assignment?.port,
    url: assignment?.url,
    dockerContainer: service.docker?.containerName,
    dockerNetwork: service.docker ? config.dockerNetwork : undefined,
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    startedAt: new Date().toISOString(),
  };
}
