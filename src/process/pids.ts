import { spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveServiceCwd } from '../config/index.ts';
import { portlerDir } from '../state/index.ts';
import { withProjectLock } from '../state/lock.ts';
import {
  isObject,
  isOptionalBoolean,
  isOptionalPort,
  isOptionalString,
  isOptionalStringArray,
  isPositiveInteger,
  isString,
} from '../util/guards.ts';
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
    isOptionalBoolean(value.prod) &&
    (value.runMode === undefined || value.runMode === 'local' || value.runMode === 'docker' || value.runMode === 'k8s') &&
    isOptionalString(value.image) &&
    isOptionalBoolean(value.setup) &&
    isOptionalString(value.startToken) &&
    isOptionalStringArray(value.dependsOn) &&
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

/**
 * Like isPidRunning, but a zombie counts as dead. kill(pid, 0) succeeds for a
 * process that exited and has not been reaped by its parent, and under a PID 1
 * that does not reap orphans (a container without an init) a dead service's
 * leader stays one, so the existence check alone would call it alive. The
 * state comes from /proc on Linux and `ps` on macOS, the two platforms Portler
 * supports; anywhere else, or when the state cannot be read, the existence
 * check decides.
 */
export function isPidAlive(pid: number): boolean {
  if (!isPidRunning(pid)) return false;
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      // A zombie still has a /proc entry, so a failed read never means
      // "zombie". It means gone since the existence check, or that the state
      // is unreadable: no /proc mount, a permission error, or a procfs with
      // hidepid, which answers ENOENT for a live process of another user.
      // Ask the existence check again and take its answer. A hidden zombie
      // stays indistinguishable from a hidden live process.
      return isPidRunning(pid);
    }
    // `pid (comm) S ...`; comm may contain spaces or parentheses.
    const state = stat.charAt(stat.lastIndexOf(')') + 2);
    return state !== 'Z' && state !== 'X';
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.error) return true;
    if (result.status !== 0) return false;
    return !result.stdout.trim().startsWith('Z');
  }
  return true;
}

/**
 * True while the process group still holds a process that can run.
 * kill(-pgid, 0) also succeeds for a group whose only members are zombies, and
 * under a PID 1 that does not reap orphans (a container without an init) a
 * stopped service's group stays like that for good, so the signal check alone
 * would never see it go. On Linux, once the signal check says the group is
 * there, its members are read from /proc and the group counts as gone only when
 * two consecutive scans find the same members, all zombies (see
 * groupHoldsOnlyZombies). A member counts as a zombie only when every one of its
 * threads is: a multithreaded process whose main thread has exited reads as a
 * zombie in /proc/<pid>/stat while its other threads keep running. Anything
 * unclear keeps the answer "alive": no /proc, a member or thread whose state
 * cannot be read, or a procfs mounted with hidepid,
 * which hides other users' processes. On macOS launchd reaps orphans, and
 * elsewhere the signal check decides. EPERM counts as alive: the group is
 * there, just not ours to signal.
 */
export function processGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  return linuxGroupHasLiveMember(pgid);
}

function linuxGroupHasLiveMember(pgid: number): boolean {
  let mounts: string;
  try {
    mounts = readFileSync('/proc/self/mounts', 'utf8');
  } catch {
    return true;
  }
  if (procHidesProcesses(mounts)) return true;
  return !groupHoldsOnlyZombies(() => scanProcGroup(pgid));
}

/**
 * One pass over /proc: what it saw of the group, or 'unknown' when a member's state
 * cannot be read. `members` holds every member pid, every thread id a zombie member
 * listed (`pid/tid`), and every pid that exited between the listing and its own read
 * (`?pid`, its group unknown). Two scans compare equal only when nothing came, went or
 * changed in between, which is what groupHoldsOnlyZombies relies on.
 */
export type GroupScan = { members: string[]; live: boolean } | 'unknown';

/** One pass over a procfs (`procRoot` is only for tests). */
export function scanProcGroup(pgid: number, procRoot = '/proc'): GroupScan {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return 'unknown';
  }
  const members: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcState(`${procRoot}/${entry}/stat`);
    // It exited after the listing. It may have been ours and may have forked a
    // process this listing missed, so it stays in the record and the next scan,
    // which no longer lists it, cannot match this one.
    if (stat === 'gone') {
      members.push(`?${entry}`);
      continue;
    }
    if (stat === 'unknown') return 'unknown';
    if (stat.pgrp !== pgid) continue;
    members.push(entry);
    if (!isZombieState(stat.state)) return { members, live: true };
    // The /proc/<pid>/stat state is the main thread's. Its other threads may still run.
    const threads = readThreads(`${procRoot}/${entry}/task`);
    if (threads === 'gone') continue; // reaped since; the next listing will not show it
    if (threads === 'unknown') return 'unknown';
    members.push(...threads.tids.map((tid) => `${entry}/${tid}`));
    if (threads.live) return { members, live: true };
  }
  return { members, live: false };
}

function isZombieState(state: string): boolean {
  return state === 'Z' || state === 'X';
}

/** A stat file's state and process group; 'gone' when the process or thread has exited since the listing. */
function readProcState(path: string): { state: string; pgrp: number } | 'gone' | 'unknown' {
  let stat: string;
  try {
    stat = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown';
  }
  // `pid (comm) state ppid pgrp ...`; comm may contain spaces or parentheses.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields.length < 3) return 'unknown';
  return { state: fields[0], pgrp: Number(fields[2]) };
}

/**
 * A process's listed thread ids and whether any of them can run; 'gone' when the
 * process has been reaped since. A thread that exited between the listing and its
 * own read stays listed: it may have started a thread this listing missed, and the
 * next scan, which no longer lists it, then cannot match this one.
 */
function readThreads(taskDir: string): { tids: string[]; live: boolean } | 'gone' | 'unknown' {
  let entries: string[];
  try {
    entries = readdirSync(taskDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown';
  }
  const tids: string[] = [];
  for (const tid of entries) {
    if (!/^\d+$/.test(tid)) continue;
    tids.push(tid);
    const state = readProcState(`${taskDir}/${tid}/stat`);
    if (state === 'gone') continue;
    if (state === 'unknown') return 'unknown';
    if (!isZombieState(state.state)) return { tids, live: true };
  }
  return { tids, live: false };
}

/**
 * Decides from repeated scans whether a group holds only zombies. One scan is not
 * enough: a live process or thread can start another after the listing and exit
 * before its own state is read, so the new one is missed. The answer is yes only when
 * two consecutive scans record the same processes and threads, including any that
 * exited mid-read, and none of them can run. Nothing then exited during the first
 * scan (it would be missing from the second listing), and every process and thread of
 * the second scan was already a zombie when the first scan read it, before the second
 * listing, so none of them could start one the second listing missed. A live member,
 * an unreadable one, or records that keep changing for `attempts` scans keep the
 * answer no.
 */
export function groupHoldsOnlyZombies(scan: () => GroupScan, attempts = 4): boolean {
  let previous = scan();
  for (let i = 1; i < attempts; i++) {
    if (previous === 'unknown' || previous.live) return false;
    const current = scan();
    if (current === 'unknown' || current.live) return false;
    if (sameMembers(previous.members, current.members)) return true;
    previous = current;
  }
  return false;
}

function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((member) => seen.has(member));
}

/** True when the procfs at /proc is mounted with a hidepid option that hides processes. */
export function procHidesProcesses(mounts: string): boolean {
  for (const line of mounts.split('\n')) {
    const [, mountPoint, type, options] = line.split(' ');
    if (mountPoint !== '/proc' || type !== 'proc' || !options) continue;
    for (const option of options.split(',')) {
      if (!option.startsWith('hidepid=')) continue;
      const value = option.slice('hidepid='.length);
      if (value !== '0' && value !== 'off') return true;
    }
  }
  return false;
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
export interface LaunchPlan {
  runMode: 'local' | 'docker' | 'k8s';
  /** The `--image` pin for this service, if one was given. */
  image?: string;
  /** `false` when started with `--no-setup`. */
  setup?: boolean;
}

export async function pidInfoFor(
  config: PortlerConfig,
  service: ServiceConfig,
  child: ChildProcess,
  assignment: ServiceAssignment | undefined,
  launch?: LaunchPlan,
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
    prod: config.production === true,
    ...(launch ? { runMode: launch.runMode } : {}),
    ...(launch?.image !== undefined ? { image: launch.image } : {}),
    ...(launch?.setup === false ? { setup: false } : {}),
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    // Always recorded, empty included: an entry without the field was written
    // by an older Portler, which is a different fact from "no dependencies".
    dependsOn: service.dependsOn.map((dependency) => dependency.service),
    startedAt: new Date().toISOString(),
  };
}
