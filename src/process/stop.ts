/**
 * Stopping services safely.
 *
 * Every signal Portler sends goes to a process GROUP (`kill(-pid)`), because a
 * service leader is usually a `shell: true` wrapper whose grandchild is the
 * actual server. That makes a wrong pid catastrophic rather than merely rude:
 * signalling a recycled pid takes out a stranger's whole process tree.
 *
 * The rules enforced here:
 *
 * 1. Only a pid whose recorded start token still matches is signalled. Legacy
 *    entries (no token) and entries whose token capture failed are NEVER
 *    signalled by an ordinary `down` — they are reported and left alone.
 * 2. Identity is re-verified immediately before SIGTERM and again before
 *    SIGKILL, not once up front: the pid can be released and recycled inside
 *    the grace window, which is precisely when we are about to signal it.
 * 3. When the group leader exits but its group still has members, the kernel
 *    keeps the pgid reserved, so the pid number cannot have been handed out
 *    again. Only in that case — and only after we already proved the pid was
 *    ours — does Portler keep signalling a group whose leader is gone.
 * 4. "stopped" is a claim about the WORLD, not about a system call: a service is
 *    only reported stopped once its process group is confirmed gone. Sending
 *    SIGTERM is not enough — the second (SIGKILL) round can refuse to signal
 *    (the pid was recycled in the grace window, or its token became unreadable),
 *    the kill can fail (EPERM), or the group can simply survive. Each of those
 *    keeps the service out of `stopped`, keeps its PID entry, and makes `down`
 *    exit non-zero.
 */
import { sleep } from '../util/sleep.ts';
import { identityVerdict, readProcessStartToken } from './identity.ts';
import type { IdentityVerdict } from './identity.ts';
import { removeOwnedContainer, removeOwnedNetwork, warnForeignResource } from './ownership.ts';
import type { RemovalOutcome } from './ownership.ts';
import { isPidAlive, isPidRunning, processGroupAlive, processGroupAliveAfterKill, readPids, removePidEntries } from './pids.ts';
import type { PidServiceInfo } from '../types/index.ts';

const SIGTERM_GRACE_MS = 1_500;
/** How long a SIGKILLed group may take to actually disappear before we call it a failure. */
const SIGKILL_CONFIRM_MS = 2_000;
const POLL_MS = 50;

export interface StopOptions {
  /**
   * Signal pids whose identity cannot be verified (legacy entries, failed token
   * capture). An explicit user act — `portler down --force` — never the default.
   * A pid proven to belong to someone ELSE ('reused') is never signalled, with
   * or without this flag.
   */
  force?: boolean;
}

export interface StopResult {
  /** Services whose process group is CONFIRMED gone (or was already gone when we signalled). */
  stopped: string[];
  /** Live pids we refused to signal because we could not prove they are ours. */
  unverified: string[];
  /**
   * Work that did not complete: a Docker resource that could not be removed, a
   * signal the kernel rejected, a group that survived SIGKILL. Their PID entries
   * are kept and `down` exits non-zero.
   */
  failures: string[];
  /** Targets fully cleaned (including stale/already-gone entries); their ports may be released. */
  completed: string[];
  /** Targets deliberately kept in pids.json; their reservations must remain. */
  remaining: string[];
}

/** 'alive' also covers EPERM: the group exists, it is simply not ours to signal. */
export type GroupState = 'alive' | 'gone';

/** A group holding only zombies is gone: see processGroupAlive. */
function realProcessGroupState(pid: number): GroupState {
  return processGroupAlive(pid) ? 'alive' : 'gone';
}

/** The same question for a group this stop has sent SIGKILL: see processGroupAliveAfterKill. */
function realProcessGroupStateAfterKill(pid: number): GroupState {
  return processGroupAliveAfterKill(pid) ? 'alive' : 'gone';
}

/**
 * The result of actually trying to signal a process group.
 *
 * 'gone' (ESRCH) is a SUCCESS for a teardown: the thing we wanted dead is dead.
 * Anything else — EPERM above all — is a failure that used to be swallowed,
 * which let `down` report a service as stopped while its group kept running.
 */
export type SignalOutcome = { status: 'sent' } | { status: 'gone' } | { status: 'error'; message: string };

function realSendSignal(pid: number, signal: NodeJS.Signals): SignalOutcome {
  try {
    process.kill(-pid, signal);
    return { status: 'sent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { status: 'gone' };

    // We deliberately do NOT fall back to kill(pid): the pid alone is exactly
    // the unsafe target this module exists to avoid.
    return {
      status: 'error',
      message: `could not send ${signal} to process group ${pid}: ${code ?? (error as Error).message}`,
    };
  }
}

/**
 * The system calls this module makes, injectable so the tests can drive the
 * races that matter (a token that stops matching between SIGTERM and SIGKILL, a
 * kill the kernel rejects, a group that survives SIGKILL) deterministically,
 * without needing the OS to recycle a pid on cue. Production always uses the
 * real ones.
 */
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

/**
 * True while the leader or any member of its group is still alive. A zombie is
 * not: under a PID 1 that does not reap orphans a stopped service stays one for
 * good, and waiting for it to vanish would turn every teardown there into a
 * reported failure. The identity check still uses pidRunning, because a zombie
 * leader keeps its start token and so still proves the group is ours.
 * `afterKill` is set once this stop has sent the group SIGKILL: no member can
 * start another process then, so the group state needs no repeated scans.
 */
function isProcessGroupRunning(probes: Probes, pid: number, afterKill: boolean): boolean {
  const group = afterKill ? probes.groupStateAfterKill(pid) : probes.groupState(pid);
  return group === 'alive' || probes.pidAlive(pid);
}

export type SignalAction = 'group' | 'none';

/**
 * The one place that decides whether a signal may be sent. Pure, so every
 * branch is unit-testable without spawning or killing anything.
 *
 * `provenOurs` means: earlier in THIS stop, with the group alive, the leader's
 * start token matched. That is what licenses the 'gone' + live-group case —
 * the kernel cannot recycle a pid that is still in use as a pgid, so a group
 * that has been alive continuously since we proved ownership is still ours.
 * Without that prior proof, a live group whose leader is gone is unprovable and
 * must be left alone: it could be a stranger's group on a recycled pid.
 */
export function signalDecision(verdict: IdentityVerdict, group: GroupState, provenOurs: boolean): SignalAction {
  if (verdict === 'match') return 'group';
  // Someone else holds this pid. Never signal it, and never its group.
  if (verdict === 'reused') return 'none';
  // Live pid we cannot identify: only an explicit --force reaches here (the
  // caller maps force onto 'match'-like handling), so refuse.
  if (verdict === 'unverifiable') return 'none';

  return group === 'alive' && provenOurs ? 'group' : 'none';
}

async function verifyPid(probes: Probes, info: PidServiceInfo): Promise<IdentityVerdict> {
  const exists = probes.pidRunning(info.pid);
  const current = exists ? await probes.readStartToken(info.pid) : null;

  return identityVerdict(info.startToken, current, exists);
}

/** Per-service state carried through the stop. */
interface Target {
  name: string;
  info: PidServiceInfo;
  /** We proved this pid was ours at some point during this stop. */
  provenOurs: boolean;
  /** The user authorized signalling an unverifiable pid (--force). */
  forced: boolean;
  /** The most recent verdict, used to decide what bookkeeping is safe to drop. */
  verdict: IdentityVerdict;
  /** The group's state at that verdict. */
  group: GroupState;
}

/** What one round of signalling did to one target. */
type RoundResult =
  /** The signal reached the group (or the group was already gone). */
  | { status: 'signalled' }
  /** Identity could not be (re-)established, so nothing was signalled. */
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

/**
 * Remove this project's Docker containers, refusing to touch foreign name
 * collisions and reporting daemon/permission errors instead of swallowing them.
 * Returns the service names whose container could NOT be cleaned up, plus
 * human-readable failure messages.
 */
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
    // Do NOT erase the bookkeeping that names the resource we failed to remove:
    // it is the only record of what is left behind.
    for (const service of services) keep.add(service);
  }
}

/** Remove this project's Docker networks (full teardown only). */
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

/**
 * Send one signal to every target that is still provably ours, re-verifying
 * identity immediately beforehand. Returns, per target, whether the signal went
 * out, was refused, or failed — the caller needs all three: a refusal in the
 * SIGKILL round means the pid stopped being provably ours DURING the stop, which
 * is exactly the case where reporting "stopped" would be a lie.
 */
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

      // --force converts "cannot prove" into permission to signal: a live pid we
      // cannot identify, or a live group whose leader is gone and which we never
      // proved. It NEVER covers 'reused' — that pid demonstrably belongs to
      // someone else, and no flag makes killing their process group acceptable.
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

/** A refusal in the second round: the pid stopped being provably ours mid-stop. */
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

/**
 * Stop services started by Portler: remove their Docker containers, signal the
 * process groups we can prove are ours (SIGTERM then SIGKILL), prune the PID
 * entries that are safe to prune, and clean up Docker networks once every
 * service is gone.
 *
 * A service is 'stopped' ONLY when its process group is confirmed gone. Having
 * sent it a signal is not the same thing, and reporting it as such is how `down`
 * exits 0, drops the bookkeeping and releases the port of a service that is
 * still running.
 *
 * PID bookkeeping is pruned deliberately, not wholesale:
 * - group confirmed gone -> entry removed
 * - pid gone / reused by a stranger -> entry removed (it is stale by definition)
 * - live but unverifiable -> entry KEPT, so the service stays visible to
 *   `portler ps` and the user can act on it
 * - still alive after SIGKILL, or the signal failed -> entry KEPT and reported
 *   as a failure: the process is still out there
 * - Docker cleanup failed -> entry KEPT, so the container/network it names is
 *   not forgotten
 */
// A leader that still answers at its pid (a zombie, or a live process) is not
// runnable code of this service when the pid is not alive, or when a second
// identity check finds it gone or handed to someone else. The second check
// stops a pid reused between the first check and this one from reading as the
// leader still running.
async function leaderNotRunnable(probes: Probes, info: PidServiceInfo): Promise<boolean> {
  if (!probes.pidAlive(info.pid)) return true;
  const again = await verifyPid(probes, info);
  return again === 'gone' || again === 'reused';
}

/**
 * Splits the services to stop into levels, dependents first: a service is only
 * stopped once every selected service that depends on it has been. Edges come
 * from the `dependsOn` each PID entry recorded when it started, so the order is
 * the one that run actually used, whatever portler.yml says now. An entry
 * written before Portler recorded it has no edges and goes with the first level.
 * Names on a cycle (which config validation should rule out) share the last level.
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

/**
 * Stops the selected services (all of them when `serviceNames` is omitted),
 * dependents before the services they depend on, so a worker or an api that is
 * draining can still reach its database or queue. Each level is a full stop on
 * its own (containers, signals, confirmation, pruning) before the next starts.
 */
export async function stopServices(
  projectDir: string,
  serviceNames?: string[],
  options: StopOptions = {},
  hooks: StopHooks = {},
): Promise<StopResult> {
  const pids = await readPids(projectDir);
  if (!pids) return { stopped: [], unverified: [], failures: [], completed: [], remaining: [] };
  const targetSet = serviceNames ? new Set(serviceNames) : null;
  const selected = Object.keys(pids.services).filter((name) => !targetSet || targetSet.has(name));
  const levels = stopOrder(pids.services, selected);
  if (levels.length <= 1) return stopLevel(projectDir, serviceNames, options, hooks);

  const total: StopResult = { stopped: [], unverified: [], failures: [], completed: [], remaining: [] };
  for (const level of levels) {
    const result = await stopLevel(projectDir, level, options, hooks);
    total.stopped.push(...result.stopped);
    total.unverified.push(...result.unverified);
    total.failures.push(...result.failures);
    total.completed.push(...result.completed);
    total.remaining.push(...result.remaining);
  }
  return total;
}

async function stopLevel(
  projectDir: string,
  serviceNames: string[] | undefined,
  options: StopOptions,
  hooks: StopHooks,
): Promise<StopResult> {
  const probes = resolveHooks(hooks);
  const pids = await readPids(projectDir);
  if (!pids) return { stopped: [], unverified: [], failures: [], completed: [], remaining: [] };

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

  // Containers first, for ALL selected entries: a `docker run` container can
  // outlive the shell pid supervising it, and ownership is decided by the
  // container's label — not by the pid that happened to start it.
  const containerCleanup = await removeDockerContainers(projectDir, targets);
  for (const name of containerCleanup.keep) keep.add(name);
  failures.push(...containerCleanup.failures);

  // A service whose supervising shell has already exited while its container ran
  // on: removing the running container is what stops it, and the `docker run`
  // client left in its process group exits then, possibly before `docker rm`
  // has even returned. Give that group the confirm window to go before judging
  // it, so the service reads as stopped instead of as an orphaned group nobody
  // can prove. Nothing is signalled here; a group that is still alive at the
  // deadline gets today's careful treatment.
  const settling = targets.filter(
    (target) => containerCleanup.removed.has(target.name) && !probes.pidAlive(target.info.pid),
  );
  // A group seen gone here stays gone: the leader was already not runnable, so
  // nothing of ours can bring the group back, and once its pid is free a
  // stranger may lead a group under the same number. So each target's gone is
  // remembered, and a later probe never overturns it.
  const sawGone = new Set<Target>();
  const settleDeadline = Date.now() + probes.confirmMs;
  for (;;) {
    for (const target of settling) {
      if (!sawGone.has(target) && probes.groupState(target.info.pid) === 'gone') sawGone.add(target);
    }
    if (sawGone.size === settling.length || Date.now() >= settleDeadline) break;
    await sleep(POLL_MS);
  }
  // A leader whose pid now runs a different process (its start token no longer
  // matches) has exited, whether that happened long ago or during the wait above.
  // Its group went with it: the kernel never hands out a pid that is still in use
  // as a process-group id, so the reuse proves the old group was empty, and
  // whatever group now carries that number is the stranger's. Such a service is
  // stopped once its container is removed; its pid is never signalled. This is
  // checked after the wait so a reuse during it still counts.
  const settled = new Set<Target>();
  for (const target of targets) {
    if (!containerCleanup.removed.has(target.name)) continue;
    if (settling.includes(target) && (sawGone.has(target) || probes.groupState(target.info.pid) === 'gone')) {
      settled.add(target);
    } else if ((await verifyPid(probes, target.info)) === 'reused') {
      settled.add(target);
    }
  }

  // A settled service has nothing left to signal or identify: its running
  // container was ours by label and is gone, its leader is not runnable, and its
  // group holds nothing runnable either. Verifying the leader's identity again
  // could only fail for reasons that no longer matter (an entry without a start
  // token whose leader is now a zombie reads as unverifiable), so it skips the
  // signal rounds and counts as stopped.
  for (const target of settled) stopped.push(target.name);
  // The leader can also exit after the checks above and before this round, with
  // the `docker run` client still in its group for a moment, and its pid can be
  // reused in the time it takes to look. So every refusal for a service whose
  // running container Portler just removed is held back, whatever the leader
  // looks like at this instant; below, its group gets the same confirm window as
  // the settle wait and it is judged once, afterwards.
  const termRound = await signalRound(
    probes,
    targets.filter((target) => !settled.has(target)),
    'SIGTERM',
    true,
    (target, verdict) => containerCleanup.removed.has(target.name) && verdict !== 'reused',
  );
  const termed: Target[] = [];
  const lateSettling: Target[] = [];

  // Bookkeeping policy for everything we did not signal:
  //
  // - 'reused': the pid is provably a stranger's, so OUR service is long gone.
  //   The entry is stale by definition — drop it (and never signal the pid).
  // - 'unverifiable': a live pid that may well be our service. Keep the entry so
  //   it stays visible instead of being silently orphaned.
  // - 'gone' with a live process group we never proved: something is still
  //   running under that pgid. Keep the entry and say so.
  // - the kill itself failed (EPERM): a live group we are not allowed to signal.
  //   That is a failure, not a stop.
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

  // A held-back refusal: Portler removed this service's running container, so
  // the only thing left is whatever its group still holds. Wait for that group
  // the same bounded time the settle wait gives, without signalling anything,
  // then judge it once from a fresh look. A leader pid that a different process
  // now holds means stopped, for the reason given at the settle wait: the reuse
  // proves the old group emptied, and a group alive under that number now is the
  // stranger's. A group that is gone with a leader that is not runnable means
  // stopped too. Anything else (a live leader Portler cannot identify, or a
  // group still alive under it): the refusal stands, with the warning the round
  // held back. The sampled verdict is what counts: a leader seen gone with its
  // group seen gone is stopped, whatever a later look at that pid number finds.
  // A service that already sat through the settle wait keeps that wait's
  // deadline instead of getting a second window, so no service waits longer
  // than one confirm window in all. Each one is judged as soon as its own
  // deadline passes or its group goes, not when the last of them is done.
  const lateStart = Date.now();
  const lateDeadlineFor = (target: Target): number =>
    settling.includes(target) ? settleDeadline : lateStart + probes.confirmMs;
  // A group seen gone in the wait below is LATCHED and handed in: its pid can
  // go to a stranger a moment later, whose own group would then read as alive.
  // Once the group has been seen gone, only a leader proven ours by its start
  // token and still runnable (our own process, moved to another group) keeps
  // the entry; a stranger at the pid can never prove that.
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

  // "Gone" is LATCHED the moment it is observed. A group that has exited cannot
  // come back — but its pid can be handed to a stranger a moment later, and
  // re-probing it afterwards would then read as "still running" and turn a
  // completed teardown into a reported failure.
  const confirmedGone = new Set<Target>();
  const sentKill = new Set<Target>();
  const observe = (target: Target): boolean => {
    if (confirmedGone.has(target)) return true;
    if (isProcessGroupRunning(probes, target.info.pid, sentKill.has(target))) return false;
    confirmedGone.add(target);
    return true;
  };

  // Give the groups up to the grace period to exit, but move on as soon as they
  // are all gone (vacuously immediate when nothing was signalled).
  const deadline = Date.now() + probes.graceMs;
  while (Date.now() < deadline && !termed.every((target) => observe(target))) {
    await sleep(POLL_MS);
  }

  // Re-verify before SIGKILL: inside the grace window the leader may have
  // exited and the pid may already have been handed to someone else.
  const survivors = termed.filter((target) => !observe(target));
  const killRound = await signalRound(probes, survivors, 'SIGKILL', false);

  // SIGKILL is not synchronous — the group takes a moment to disappear. Wait for
  // that (bounded), because a confirmed-gone group is the only evidence that
  // licenses reporting a service as stopped and dropping its bookkeeping.
  const killDeadline = Date.now() + probes.confirmMs;
  const killed = survivors.filter((target) => killRound.get(target)!.status === 'signalled');
  for (const target of killed) sentKill.add(target);
  while (Date.now() < killDeadline && !killed.every((target) => observe(target))) {
    await sleep(POLL_MS);
  }
  for (const target of survivors) observe(target);

  // The verdict for every service we signalled: a group confirmed gone is
  // stopped; anything still alive means the teardown did NOT complete, so the
  // service is reported as unverified (identity) or failed (everything else),
  // and its PID entry is kept.
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

  // Networks last, and only on a full teardown: another service of this project
  // may still be attached.
  const selectedNames = targets.map((target) => target.name);
  const isFullTeardown = targets.length === Object.keys(pids.services).length;

  if (isFullTeardown) {
    const networkCleanup = await removeDockerNetworks(projectDir, targets);
    for (const name of networkCleanup.keep) keep.add(name);
    failures.push(...networkCleanup.failures);
  }

  const completed = selectedNames.filter((name) => !keep.has(name));
  const remaining = selectedNames.filter((name) => keep.has(name));
  if (completed.length > 0) await removePidEntries(projectDir, completed);

  // Removing a service's running container is what stops it. Whatever the
  // signal rounds made of its leader afterwards (a group that exited between the
  // last settle check and the round reads as plain stale), a service whose
  // running container we removed and whose entry is now pruned was stopped.
  for (const name of completed) {
    if (containerCleanup.removed.has(name) && !stopped.includes(name)) stopped.push(name);
  }

  return { stopped, unverified, failures, completed, remaining };
}
