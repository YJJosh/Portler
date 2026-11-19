import { spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedVolumeName, resolveServiceCwd } from '../config/index.ts';
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
    isOptionalString(value.volumeSet) &&
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
  // A copied checkout carries `.portler/pids.json` with matching start tokens, so a different
  // `project` is rejected: `down` in the copy would kill the original's process groups.
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
 * Read-modify-write under the project lock (a lost write orphans a process); removes the file
 * once empty. A corrupt pids.json throws: overwriting it would lose the only record of those pids.
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

/** EPERM (another user's process) counts as existing: callers use this to judge an entry stale. */
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
 * Like isPidRunning, but a zombie is dead (a PID 1 that does not reap keeps one forever). State
 * from /proc (Linux) or `ps` (macOS); elsewhere, or unreadable, the existence check decides.
 */
export function isPidAlive(pid: number): boolean {
  if (!isPidRunning(pid)) return false;
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      // A zombie keeps its /proc entry, so a failed read means gone or unreadable (no /proc,
      // EPERM, hidepid answering ENOENT for another user's process).
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
 * kill(-pgid, 0) also succeeds for an all-zombie group, which a non-reaping PID 1 never clears. On
 * Linux it is gone only when /proc scans agree every member thread is a zombie; anything unclear
 * (no /proc, hidepid) and EPERM count as alive. macOS launchd reaps, so the signal check decides.
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
  if (!procShowsEveryProcess()) return true;
  return !groupHoldsOnlyZombies(() => scanProcGroup(pgid));
}

/**
 * For a group just sent SIGKILL: the kernel delivers it to every member, forks in progress
 * included, so one scan is enough even on a busy host. A member still dying counts as alive.
 */
export function processGroupAliveAfterKill(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  if (!procShowsEveryProcess()) return true;
  return !groupDeadAfterKill(scanProcGroup(pgid));
}

export function groupDeadAfterKill(scan: GroupScan): boolean {
  return scan !== 'unknown' && !scan.live;
}

function procShowsEveryProcess(): boolean {
  try {
    return !procHidesProcesses(readFileSync('/proc/self/mounts', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * `members`: member pids, plus each thread of a zombie member (`pid/tid`). `settled` is false
 * when one exited between listing and read: it may have forked one the listing missed.
 */
export type GroupScan = { members: string[]; live: boolean; settled: boolean } | 'unknown';

/** `procRoot` is for tests. */
export function scanProcGroup(pgid: number, procRoot = '/proc'): GroupScan {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return 'unknown';
  }
  const members: string[] = [];
  let settled = true;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readProcState(`${procRoot}/${entry}/stat`);
    if (stat === 'gone') {
      settled = false;
      continue;
    }
    if (stat === 'unknown') return 'unknown';
    if (stat.pgrp !== pgid) continue;
    members.push(entry);
    if (!isZombieState(stat.state)) return { members, live: true, settled };
    // /proc/<pid>/stat shows the main thread's state; other threads may still run.
    const threads = readThreads(`${procRoot}/${entry}/task`);
    if (threads === 'gone') {
      settled = false; // reaped since its stat was read
      continue;
    }
    if (threads === 'unknown') return 'unknown';
    members.push(...threads.tids.map((tid) => `${entry}/${tid}`));
    if (!threads.settled) settled = false;
    if (threads.live) return { members, live: true, settled };
  }
  return { members, live: false, settled };
}

function isZombieState(state: string): boolean {
  return state === 'Z' || state === 'X';
}

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

// A thread that exited before its read leaves the result unsettled: it may have started one
// the listing missed.
function readThreads(taskDir: string): { tids: string[]; live: boolean; settled: boolean } | 'gone' | 'unknown' {
  let entries: string[];
  try {
    entries = readdirSync(taskDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? 'gone' : 'unknown';
  }
  const tids: string[] = [];
  let settled = true;
  for (const tid of entries) {
    if (!/^\d+$/.test(tid)) continue;
    const state = readProcState(`${taskDir}/${tid}/stat`);
    if (state === 'gone') {
      settled = false;
      continue;
    }
    if (state === 'unknown') return 'unknown';
    tids.push(tid);
    if (!isZombieState(state.state)) return { tids, live: true, settled };
  }
  return { tids, live: false, settled };
}

/**
 * One scan misses a child forked after the listing by a process that exits before its read, so
 * true only when two consecutive settled scans list the same all-zombie members. On a busy host
 * scans can stay unsettled for all `attempts`; then only processGroupAliveAfterKill answers.
 */
export function groupHoldsOnlyZombies(scan: () => GroupScan, attempts = 4): boolean {
  let previous = scan();
  for (let i = 1; i < attempts; i++) {
    if (previous === 'unknown' || previous.live) return false;
    const current = scan();
    if (current === 'unknown' || current.live) return false;
    if (previous.settled && current.settled && sameMembers(previous.members, current.members)) return true;
    previous = current;
  }
  return false;
}

function sameMembers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((member) => seen.has(member));
}

/** True when /proc is mounted with a hidepid option that hides processes. */
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

export interface LaunchPlan {
  runMode: 'local' | 'docker' | 'k8s';
  /** The `--image` pin for this service, if one was given. */
  image?: string;
  /** `false` when started with `--no-setup`. */
  setup?: boolean;
}

/** Records the start token so `down` can prove the pid was not recycled. */
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
    // '' means the base volumes; a missing field means an older Portler wrote it.
    ...(service.docker?.volumes.some((volume) => managedVolumeName(volume) !== undefined)
      ? { volumeSet: config.volumeSet ?? '' }
      : {}),
    startToken: (await readProcessStartToken(child.pid)) ?? undefined,
    // Always recorded, even empty: a missing field means an older Portler wrote it.
    dependsOn: service.dependsOn.map((dependency) => dependency.service),
    startedAt: new Date().toISOString(),
  };
}
