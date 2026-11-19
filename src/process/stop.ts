/**
 * Signals go to process groups (`kill(-pid)`; the leader is often a `shell: true` wrapper),
 * so a wrong pid kills a stranger's tree. Signal only a pid whose start token matches,
 * re-verified before SIGTERM and again before SIGKILL (pids recycle in the grace window).
 * The kernel keeps a pgid reserved while the group has members, so a group proven ours
 * earlier in this stop may be signalled after its leader exits. "Stopped" means the group
 * is confirmed gone; a refused SIGKILL, EPERM or a survivor keeps the entry and fails `down`.
 */
import { sleep } from '../util/sleep.ts';
import { identityVerdict, readProcessStartToken } from './identity.ts';
import type { IdentityVerdict } from './identity.ts';
import { removeOwnedContainer, removeOwnedNetwork, warnForeignResource } from './ownership.ts';
import type { RemovalOutcome } from './ownership.ts';
import { isPidAlive, isPidRunning, processGroupAlive, processGroupAliveAfterKill, readPids, removePidEntries, updatePids } from './pids.ts';
import type { PidServiceInfo } from '../types/index.ts';

const SIGTERM_GRACE_MS = 1_500;
// A group still alive this long after SIGKILL counts as a failure.
const SIGKILL_CONFIRM_MS = 2_000;
const POLL_MS = 50;

export interface StopOptions {
  /** Signal unverifiable pids (no start token, failed capture); a 'reused' pid never. */
  force?: boolean;
}

export interface StopResult {
  /** Services whose process group is confirmed gone. */
  stopped: string[];
  /** Live pids not signalled because they could not be proven ours. */
  unverified: string[];
  /** Failed Docker removals, rejected signals, groups alive after SIGKILL; entries kept, `down` fails. */
  failures: string[];
  /** Targets fully cleaned, stale entries included; their ports may be released. */
  completed: string[];
  /** Targets kept in pids.json; their port reservations must remain. */
  remaining: string[];
  /** Services whose running container was removed (dependents lost it), even if the entry is kept. */
  containersRemoved: string[];
}

/** 'alive' also covers EPERM: the group exists but is not ours to signal. */
export type GroupState = 'alive' | 'gone';

// A group of only zombies reads as gone (see processGroupAlive).
function realProcessGroupState(pid: number): GroupState {
  return processGroupAlive(pid) ? 'alive' : 'gone';
}

function realProcessGroupStateAfterKill(pid: number): GroupState {
  return processGroupAliveAfterKill(pid) ? 'alive' : 'gone';
}

/** 'gone' (ESRCH) is a teardown success; 'error' (EPERM above all) means the group may still run. */
export type SignalOutcome = { status: 'sent' } | { status: 'gone' } | { status: 'error'; message: string };

function realSendSignal(pid: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    process.kill(-pid, signal);
    return { status: 'sent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { status: 'gone' };

    // Never fall back to kill(pid): the bare pid is the unsafe target.
    return {
      status: 'error',
      message: `could not send ${signal} to process group ${pid}: ${code ?? (error as Error).message}`,
    };
  }
}

/** Test hooks for the system calls, to drive races: token change mid-stop, rejected kill, survivor. */
export interface StopHooks {
  readStartToken?: (pid: number) => Promise<string | null>;
  pidRunning?: (pid: number) => boolean;
  /** Like pidRunning, but a zombie counts as dead; defaults to pidRunning when that is injected. */
  pidAlive?: (pid: number) => boolean;
  groupState?: (pid: number) => GroupState;
  /** groupState for a group this stop has sent SIGKILL; defaults to groupState when that is injected. */
  groupStateAfterKill?: (pid: number) => GroupState;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => SignalOutcome;
  graceMs?: number;
  confirmMs?: number;
}

interface Probes {
  readStartToken: (pid: number) => Promise<string | null>;
  pidRunning: (pid: number) => boolean;
  pidAlive: (pid: number) => boolean;
  groupState: (pid: number) => GroupState;
  groupStateAfterKill: (pid: number) => GroupState;
  sendSignal: (pid: number, signal: NodeJS.Signals) => SignalOutcome;
  graceMs: number;
  confirmMs: number;
}

function resolveHooks(hooks: StopHooks): Probes {
  return {
    readStartToken: hooks.readStartToken ?? ((pid) => readProcessStartToken(pid)),
    pidRunning: hooks.pidRunning ?? isPidRunning,
    pidAlive: hooks.pidAlive ?? hooks.pidRunning ?? isPidAlive,
    groupState: hooks.groupState ?? realProcessGroupState,
    groupStateAfterKill: hooks.groupStateAfterKill ?? hooks.groupState ?? realProcessGroupStateAfterKill,
    sendSignal: hooks.sendSignal ?? realSendSignal,
    graceMs: hooks.graceMs ?? SIGTERM_GRACE_MS,
    confirmMs: hooks.confirmMs ?? SIGKILL_CONFIRM_MS,
  };
}

// Zombies count as gone (a PID 1 that does not reap never clears them); identity checks use
// pidRunning, as a zombie keeps its token. After SIGKILL no member can fork: no repeated scans.
function isProcessGroupRunning(probes: Probes, pid: number, afterKill: boolean): boolean {
  const group = afterKill ? probes.groupStateAfterKill(pid) : probes.groupState(pid);
  return group === 'alive' || probes.pidAlive(pid);
}

export type SignalAction = 'group' | 'none';

/**
 * The one place that decides whether a signal may be sent. `provenOurs` (token matched earlier
 * in this stop, group alive since) keeps a leaderless group ours: a pgid in use is not recycled.
 */
export function signalDecision(verdict: IdentityVerdict, group: GroupState, provenOurs: boolean): SignalAction {
  if (verdict === 'match') return 'group';
  // Someone else holds this pid: never signal it or its group.
  if (verdict === 'reused') return 'none';
  // --force is applied by the caller (signalRound), not here.
  if (verdict === 'unverifiable') return 'none';

  return group === 'alive' && provenOurs ? 'group' : 'none';
}

async function verifyPid(probes: Probes, info: PidServiceInfo): Promise<IdentityVerdict> {
  const exists = probes.pidRunning(info.pid);
  const current = exists ? await probes.readStartToken(info.pid) : null;

  return identityVerdict(info.startToken, current, exists);
}

interface Target {
  name: string;
  info: PidServiceInfo;
  /** The start token matched at some point during this stop. */
  provenOurs: boolean;
  /** --force: an unverifiable pid may be signalled. */
  forced: boolean;
  /** The latest verdict; decides which bookkeeping is safe to drop. */
  verdict: IdentityVerdict;
  /** The group's state at that verdict. */
  group: GroupState;
}

type RoundResult =
  /** Sent, or the group was already gone (ESRCH). */
  | { status: 'signalled' }
  /** Identity not proven, so nothing was sent. */
  | { status: 'refused'; verdict: IdentityVerdict; group: GroupState; deferred: boolean }
  /** The kernel rejected the signal (EPERM, ...). */
  | { status: 'error'; message: string };

function warnReused(name: string, pid: number): void {
  process.stderr.write(
    `[portler] warning: pid ${pid} recorded for service "${name}" now belongs to a DIFFERENT process ` +
      '(the pid was reused by the OS). Not signalling it — that would kill an unrelated process tree. ' +
      'Clearing the stale entry instead.\n',
  );
}

function warnUnverifiable(name: string, pid: number, forced: boolean): void {
  if (forced) {
    process.stderr.write(
      `[portler] warning: --force: signalling pid ${pid} ("${name}") even though its identity cannot be verified. ` +
        'If the OS reused this pid, an unrelated process group is being killed.\n',
    );
    return;
  }

  process.stderr.write(
    `[portler] warning: pid ${pid} recorded for service "${name}" is running, but Portler cannot prove it is still ` +
      'the process it started (the entry predates start-token recording, or the token could not be captured). ' +
      'It will NOT be signalled: the pid may have been recycled onto an unrelated process. ' +
      `Check it with "ps -o pid,ppid,lstart,command -p ${pid}", then stop it yourself, or re-run with ` +
      '"portler down --force" to signal it anyway. The PID entry is kept so it stays visible.\n',
  );
}

function warnOrphanGroup(name: string, pid: number): void {
  process.stderr.write(
    `[portler] warning: the pid ${pid} recorded for service "${name}" is gone, but a process group ${pid} still ` +
      'exists. Portler did not verify that group as its own during this run, so it will not signal it (the pid — and ' +
      'with it the group id — may have been recycled). ' +
      `Inspect it with "ps -eo pid,pgid,command | awk '$2 == ${pid}'".\n`,
  );
}

// Foreign containers are left alone. `keep`: services whose container could not be removed;
// `removed`: those whose running container was removed.
async function removeDockerContainers(
  projectDir: string,
  targets: Target[],
): Promise<{ keep: Set<string>; failures: string[]; removed: Set<string> }> {
  const byContainer = new Map<string, string[]>();
  for (const target of targets) {
    const container = target.info.dockerContainer;
    if (!container) continue;
    byContainer.set(container, [...(byContainer.get(container) ?? []), target.name]);
  }

  const keep = new Set<string>();
  const failures: string[] = [];
  const removed = new Set<string>();

  await Promise.all(
    [...byContainer].map(async ([container, services]) => {
      const outcome = await removeOwnedContainer(container, projectDir);
      if (outcome.status === 'removed' && outcome.running === true) for (const service of services) removed.add(service);
      handleRemoval('container', container, services, outcome, keep, failures);
    }),
  );

  return { keep, failures, removed };
}

function handleRemoval(
  kind: 'container' | 'network',
  name: string,
  services: string[],
  outcome: RemovalOutcome,
  keep: Set<string>,
  failures: string[],
): void {
  if (outcome.status === 'foreign') {
    warnForeignResource(kind, name);
    return;
  }

  if (outcome.status === 'failed' || outcome.status === 'error') {
    const message = `could not remove Docker ${kind} "${name}": ${outcome.message}`;
    process.stderr.write(`[portler] warning: ${message}\n`);
    process.stderr.write(
      `[portler] keeping the PID entries for ${services.join(', ')} so the ${kind} is still recorded; ` +
        're-run "portler down" once Docker is reachable.\n',
    );
    failures.push(message);
    // Keep the entries: they are the only record of the resource left behind.
    for (const service of services) keep.add(service);
  }
}

// Full teardown only: another service may still be attached.
async function removeDockerNetworks(
  projectDir: string,
  targets: Target[],
): Promise<{ keep: Set<string>; failures: string[] }> {
  const byNetwork = new Map<string, string[]>();
  for (const target of targets) {
    const network = target.info.dockerNetwork;
    if (!network) continue;
    byNetwork.set(network, [...(byNetwork.get(network) ?? []), target.name]);
  }

  const keep = new Set<string>();
  const failures: string[] = [];

  await Promise.all(
    [...byNetwork].map(async ([network, services]) => {
      const outcome = await removeOwnedNetwork(network, projectDir);
      handleRemoval('network', network, services, outcome, keep, failures);
    }),
  );

  return { keep, failures };
}

// Re-verifies identity right before signalling. A refusal in the SIGKILL round means the pid
// stopped being provably ours mid-stop, so the service must not be reported stopped.
async function signalRound(
  probes: Probes,
  targets: Target[],
  signal: NodeJS.Signals,
  warnOnRefusal: boolean,
  deferRefusal: (target: Target, verdict: IdentityVerdict) => boolean = () => false,
): Promise<Map<Target, RoundResult>> {
  const results = new Map<Target, RoundResult>();

  await Promise.all(
    targets.map(async (target) => {
      const verdict = await verifyPid(probes, target.info);
      const group = probes.groupState(target.info.pid);
      target.verdict = verdict;
      target.group = group;

      if (verdict === 'match') target.provenOurs = true;

      // --force allows signalling what cannot be proven (an unidentified live pid,
      // or an unproven live group with a gone leader), never a 'reused' pid.
      const unprovable = verdict === 'unverifiable' || (verdict === 'gone' && group === 'alive');
      const forcedSignal = target.forced && unprovable;
      const action: SignalAction = forcedSignal ? 'group' : signalDecision(verdict, group, target.provenOurs);

      if (action === 'none') {
        // A deferred refusal is the caller's to judge (and warn about) later.
        const deferred = deferRefusal(target, verdict);
        const warn = warnOnRefusal && !deferred;
        if (warn && verdict === 'reused') warnReused(target.name, target.info.pid);
        if (warn && verdict === 'unverifiable') warnUnverifiable(target.name, target.info.pid, false);
        if (warn && verdict === 'gone' && group === 'alive') warnOrphanGroup(target.name, target.info.pid);
        results.set(target, { status: 'refused', verdict, group, deferred });
        return;
      }

      if (forcedSignal && warnOnRefusal) warnUnverifiable(target.name, target.info.pid, true);

      const outcome = probes.sendSignal(target.info.pid, signal);
      results.set(
        target,
        outcome.status === 'error' ? { status: 'error', message: outcome.message } : { status: 'signalled' },
      );
    }),
  );

  return results;
}

function warnSecondRoundRefusal(target: Target): void {
  const { name, info, verdict } = target;
  const reason =
    verdict === 'reused'
      ? 'the OS handed that pid to a DIFFERENT process while we were waiting'
      : verdict === 'unverifiable'
        ? 'its start token could no longer be read, so it can no longer be proven to be ours'
        : 'its process group is alive but can no longer be proven to be ours';

  process.stderr.write(
    `[portler] warning: service "${name}" (pid ${info.pid}) did not exit after SIGTERM, and Portler will not SIGKILL ` +
      `it: ${reason}. It is NOT reported as stopped and its PID entry is kept. ` +
      `Inspect it with "ps -o pid,ppid,lstart,command -p ${info.pid}" and stop it yourself.\n`,
  );
}

// Not alive (or a zombie), or a second identity check, which catches a pid reused since the
// first one, finds it gone or reused.
async function leaderNotRunnable(probes: Probes, info: PidServiceInfo): Promise<boolean> {
  if (!probes.pidAlive(info.pid)) return true;
  const again = await verifyPid(probes, info);
  return again === 'gone' || again === 'reused';
}

/**
 * Stop levels, dependents first, from each PID entry's recorded `dependsOn` (not the current
 * portler.yml). Entries without it go in the first level; names on a cycle share the last.
 */
export function stopOrder(services: Record<string, PidServiceInfo>, names: string[]): string[][] {
  const selected = new Set(names);
  const dependents = new Map<string, Set<string>>();
  for (const name of names) dependents.set(name, new Set());
  for (const name of names) {
    for (const dep of services[name]?.dependsOn ?? []) {
      if (dep !== name && selected.has(dep)) dependents.get(dep)!.add(name);
    }
  }
  const levels: string[][] = [];
  const done = new Set<string>();
  while (done.size < names.length) {
    const level = names.filter((name) => !done.has(name) && [...dependents.get(name)!].every((d) => done.has(d)));
    if (level.length === 0) {
      levels.push(names.filter((name) => !done.has(name)));
      break;
    }
    for (const name of level) done.add(name);
    levels.push(level);
  }
  return levels;
}

/** Stops the selected services (default: all), dependents first, so a draining worker still reaches its database. */
export async function stopServices(
  projectDir: string,
  serviceNames?: string[],
  options: StopOptions = {},
  hooks: StopHooks = {},
): Promise<StopResult> {
  const pids = await readPids(projectDir);
  if (!pids) return { stopped: [], unverified: [], failures: [], completed: [], remaining: [], containersRemoved: [] };
  const targetSet = serviceNames ? new Set(serviceNames) : null;
  const selected = Object.keys(pids.services).filter((name) => !targetSet || targetSet.has(name));
  const levels = stopOrder(pids.services, selected);
  if (levels.length <= 1) return stopLevel(projectDir, serviceNames, options, hooks, true);

  // Networks go once at the end, from the original entries: a dependent pruned in an earlier
  // level may hold the only entry naming one.
  const fullTeardown = selected.length === Object.keys(pids.services).length;
  const networkTargets: Target[] = selected
    .filter((name) => pids.services[name]!.dockerNetwork)
    .map((name) => ({
      name,
      info: pids.services[name]!,
      provenOurs: false,
      forced: false,
      verdict: 'gone' as IdentityVerdict,
      group: 'gone' as GroupState,
    }));

  const total: StopResult = { stopped: [], unverified: [], failures: [], completed: [], remaining: [], containersRemoved: [] };
  // A dependent that could not be stopped keeps its (transitive) dependencies up; otherwise a
  // restart would abort on that failure with the dependency already down.
  const heldBy = new Map<string, Set<string>>();
  const holdDependencies = (dependent: string): void => {
    const stack = [dependent];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const dep of pids.services[current]?.dependsOn ?? []) {
        if (dep === current || !selected.includes(dep)) continue;
        const holders = heldBy.get(dep) ?? new Set<string>();
        if (holders.has(current)) continue;
        holders.add(current);
        heldBy.set(dep, holders);
        stack.push(dep);
      }
    }
  };
  for (const level of levels) {
    const held = level.filter((name) => heldBy.has(name));
    for (const name of held) {
      const holders = [...heldBy.get(name)!];
      total.remaining.push(name);
      total.failures.push(
        `did not stop service "${name}": ${holders.map((holder) => `"${holder}"`).join(', ')} ${holders.length === 1 ? 'depends' : 'depend'} on it and could not be stopped`,
      );
      holdDependencies(name);
    }
    const free = level.filter((name) => !heldBy.has(name));
    if (free.length === 0) continue;
    const result = await stopLevel(projectDir, free, options, hooks, false);
    for (const name of result.remaining) holdDependencies(name);
    total.stopped.push(...result.stopped);
    total.unverified.push(...result.unverified);
    total.failures.push(...result.failures);
    total.completed.push(...result.completed);
    total.remaining.push(...result.remaining);
    total.containersRemoved.push(...result.containersRemoved);
  }

  if (fullTeardown && networkTargets.length > 0) {
    const networkCleanup = await removeDockerNetworks(projectDir, networkTargets);
    total.failures.push(...networkCleanup.failures);
    // A network not removed keeps the entries naming it: they are its only record.
    const restore = total.completed.filter((name) => networkCleanup.keep.has(name));
    if (restore.length > 0) {
      await updatePids(projectDir, (current) => {
        for (const name of restore) current.services[name] = pids.services[name]!;
      });
      total.completed = total.completed.filter((name) => !restore.includes(name));
      total.remaining.push(...restore);
    }
  }
  return total;
}

// Drops entries of gone or reused pids; keeps them for a live unverifiable pid, a failed
// signal, a group alive after SIGKILL, or a failed Docker removal.
async function stopLevel(
  projectDir: string,
  serviceNames: string[] | undefined,
  options: StopOptions,
  hooks: StopHooks,
  cleanNetworks: boolean,
): Promise<StopResult> {
  const probes = resolveHooks(hooks);
  const pids = await readPids(projectDir);
  if (!pids) return { stopped: [], unverified: [], failures: [], completed: [], remaining: [], containersRemoved: [] };

  const targetSet = serviceNames ? new Set(serviceNames) : null;
  const targets: Target[] = Object.entries(pids.services)
    .filter(([name]) => !targetSet || targetSet.has(name))
    .map(([name, info]) => ({
      name,
      info,
      provenOurs: false,
      forced: options.force === true,
      verdict: 'gone' as IdentityVerdict,
      group: 'gone' as GroupState,
    }));

  const stopped: string[] = [];
  const unverified: string[] = [];
  const failures: string[] = [];
  const keep = new Set<string>();

  // Containers first: a `docker run` container can outlive its shell pid, and ownership comes
  // from its label, not the pid.
  const containerCleanup = await removeDockerContainers(projectDir, targets);
  for (const name of containerCleanup.keep) keep.add(name);
  failures.push(...containerCleanup.failures);

  // Shell gone, container ran on: its `docker run` client exits once the container is removed,
  // maybe after `docker rm` returns. Wait (no signal) so it reads stopped, not an orphan group.
  const settling = targets.filter(
    (target) => containerCleanup.removed.has(target.name) && !probes.pidAlive(target.info.pid),
  );
  // Gone is latched: nothing of ours revives the group, and a stranger may then lead its pgid.
  const sawGone = new Set<Target>();
  const settleDeadline = Date.now() + probes.confirmMs;
  for (;;) {
    for (const target of settling) {
      if (!sawGone.has(target) && probes.groupState(target.info.pid) === 'gone') sawGone.add(target);
    }
    if (sawGone.size === settling.length || Date.now() >= settleDeadline) break;
    await sleep(POLL_MS);
  }
  // A reused leader pid proves the old group empty (the kernel never hands out a pid in use as
  // a pgid): with its container removed the service is stopped; never signal that pid.
  // Checked after the wait so a reuse during it counts.
  const settled = new Set<Target>();
  for (const target of targets) {
    if (!containerCleanup.removed.has(target.name)) continue;
    if (settling.includes(target) && (sawGone.has(target) || probes.groupState(target.info.pid) === 'gone')) {
      settled.add(target);
    } else if ((await verifyPid(probes, target.info)) === 'reused') {
      settled.add(target);
    }
  }

  // Settled services skip the signal rounds: nothing runnable is left, and re-verifying could
  // only fail for moot reasons (a token-less entry with a zombie leader reads as unverifiable).
  for (const target of settled) stopped.push(target.name);
  // The leader may exit just before this round, with the `docker run` client briefly in its
  // group and the pid reusable, so refusals for a just-removed container are judged later.
  const termRound = await signalRound(
    probes,
    targets.filter((target) => !settled.has(target)),
    'SIGTERM',
    true,
    (target, verdict) => containerCleanup.removed.has(target.name) && verdict !== 'reused',
  );
  const termed: Target[] = [];
  const lateSettling: Target[] = [];

  // Not signalled: 'reused' is a stale entry, dropped. 'unverifiable', or 'gone' with an
  // unproven live group, keeps the entry visible. A failed kill (EPERM) is a failure.
  for (const target of targets) {
    if (settled.has(target)) continue;
    const result = termRound.get(target)!;

    if (result.status === 'signalled') {
      termed.push(target);
      continue;
    }

    if (result.status === 'error') {
      process.stderr.write(`[portler] warning: ${result.message}\n`);
      failures.push(`could not stop service "${target.name}": ${result.message}`);
      keep.add(target.name);
      continue;
    }

    if (result.verdict === 'unverifiable' || (result.verdict === 'gone' && result.group === 'alive')) {
      if (result.deferred) {
        lateSettling.push(target);
        continue;
      }
      unverified.push(target.name);
      keep.add(target.name);
    }
  }

  // Deferred refusals: wait without signalling, then judge once. A reused leader pid, or a gone
  // group with a leader not runnable, is stopped; else the refusal and its warning stand.
  // A service that sat through the settle wait keeps that deadline: one confirm window at most.
  const lateStart = Date.now();
  const lateDeadlineFor = (target: Target): number =>
    settling.includes(target) ? settleDeadline : lateStart + probes.confirmMs;
  // A group seen gone is latched (its pid may lead a stranger's group). Then only a leader
  // proven ours and still runnable (moved to another group) keeps the entry.
  const judgeLate = async (target: Target, sawGroupGone: boolean): Promise<void> => {
    const verdict = await verifyPid(probes, target.info);
    const groupGone = sawGroupGone || probes.groupState(target.info.pid) === 'gone';
    if (
      verdict === 'reused' ||
      (groupGone && (verdict !== 'match' || (await leaderNotRunnable(probes, target.info))))
    ) {
      stopped.push(target.name);
      return;
    }
    const result = termRound.get(target)!;
    if (result.status === 'refused' && result.verdict === 'unverifiable') {
      warnUnverifiable(target.name, target.info.pid, false);
    } else {
      warnOrphanGroup(target.name, target.info.pid);
    }
    unverified.push(target.name);
    keep.add(target.name);
  };
  const pendingLate = [...lateSettling];
  while (pendingLate.length > 0) {
    for (const target of [...pendingLate]) {
      let sawGroupGone = false;
      if (Date.now() < lateDeadlineFor(target)) {
        if (probes.groupState(target.info.pid) === 'alive') continue;
        sawGroupGone = true;
      }
      pendingLate.splice(pendingLate.indexOf(target), 1);
      await judgeLate(target, sawGroupGone);
    }
    if (pendingLate.length > 0) await sleep(POLL_MS);
  }

  // Gone is latched: an exited group cannot return, but a stranger may take its pid, and a
  // re-probe would turn a finished teardown into a failure.
  const confirmedGone = new Set<Target>();
  const sentKill = new Set<Target>();
  const observe = (target: Target): boolean => {
    if (confirmedGone.has(target)) return true;
    if (isProcessGroupRunning(probes, target.info.pid, sentKill.has(target))) return false;
    confirmedGone.add(target);
    return true;
  };

  const deadline = Date.now() + probes.graceMs;
  while (Date.now() < deadline && !termed.every((target) => observe(target))) {
    await sleep(POLL_MS);
  }

  // signalRound re-verifies: the pid may have been recycled in the grace window.
  const survivors = termed.filter((target) => !observe(target));
  const killRound = await signalRound(probes, survivors, 'SIGKILL', false);

  // SIGKILL is asynchronous: only a group confirmed gone is reported stopped and dropped.
  const killDeadline = Date.now() + probes.confirmMs;
  const killed = survivors.filter((target) => killRound.get(target)!.status === 'signalled');
  for (const target of killed) sentKill.add(target);
  while (Date.now() < killDeadline && !killed.every((target) => observe(target))) {
    await sleep(POLL_MS);
  }
  for (const target of survivors) observe(target);

  // Not confirmed gone: keep the entry; unverified (identity) or failed (anything else).
  for (const target of termed) {
    if (confirmedGone.has(target)) {
      stopped.push(target.name);
      continue;
    }

    keep.add(target.name);
    const result = killRound.get(target)!;

    if (result.status === 'refused') {
      warnSecondRoundRefusal(target);
      unverified.push(target.name);
      continue;
    }

    if (result.status === 'error') {
      process.stderr.write(`[portler] warning: ${result.message}\n`);
      failures.push(`could not stop service "${target.name}": ${result.message}`);
      continue;
    }

    const message =
      `service "${target.name}" (pid ${target.info.pid}) was sent SIGKILL but its process group is still alive ` +
      `after ${probes.confirmMs / 1_000}s (a process stuck in uninterruptible sleep, or an unreaped group)`;
    process.stderr.write(`[portler] warning: ${message}\n`);
    failures.push(message);
  }

  // Networks only on a full teardown (another service may be attached); a staged stop
  // removes them after its last level.
  const selectedNames = targets.map((target) => target.name);
  const isFullTeardown = targets.length === Object.keys(pids.services).length;

  if (cleanNetworks && isFullTeardown) {
    const networkCleanup = await removeDockerNetworks(projectDir, targets);
    for (const name of networkCleanup.keep) keep.add(name);
    failures.push(...networkCleanup.failures);
  }

  const completed = selectedNames.filter((name) => !keep.has(name));
  const remaining = selectedNames.filter((name) => keep.has(name));
  if (completed.length > 0) await removePidEntries(projectDir, completed);

  // Removing the running container stops a Docker service: a pruned entry whose container was
  // removed counts as stopped, whatever the rounds saw.
  for (const name of completed) {
    if (containerCleanup.removed.has(name) && !stopped.includes(name)) stopped.push(name);
  }

  const containersRemoved = selectedNames.filter((name) => containerCleanup.removed.has(name));
  return { stopped, unverified, failures, completed, remaining, containersRemoved };
}
