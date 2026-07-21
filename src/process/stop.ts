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
import { isPidRunning, readPids, removePidEntries } from './pids.ts';
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

function realProcessGroupState(pid: number): GroupState {
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';

  try {
    process.kill(-pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'gone';
  }
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
  groupState?: (pid: number) => GroupState;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => SignalOutcome;
  graceMs?: number;
  confirmMs?: number;
}

interface Probes {
  readStartToken: (pid: number) => Promise<string | null>;
  pidRunning: (pid: number) => boolean;
  groupState: (pid: number) => GroupState;
  sendSignal: (pid: number, signal: NodeJS.Signals) => SignalOutcome;
  graceMs: number;
  confirmMs: number;
}

function resolveHooks(hooks: StopHooks): Probes {
  return {
    readStartToken: hooks.readStartToken ?? ((pid) => readProcessStartToken(pid)),
    pidRunning: hooks.pidRunning ?? isPidRunning,
    groupState: hooks.groupState ?? realProcessGroupState,
    sendSignal: hooks.sendSignal ?? realSendSignal,
    graceMs: hooks.graceMs ?? SIGTERM_GRACE_MS,
    confirmMs: hooks.confirmMs ?? SIGKILL_CONFIRM_MS,
  };
}

/** True while the leader or any member of its group is still alive. */
function isProcessGroupRunning(probes: Probes, pid: number): boolean {
  return probes.groupState(pid) === 'alive' || probes.pidRunning(pid);
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
  | { status: 'refused'; verdict: IdentityVerdict; group: GroupState }
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
): Promise<{ keep: Set<string>; failures: string[] }> {
  const byContainer = new Map<string, string[]>();
  for (const target of targets) {
    const container = target.info.dockerContainer;
    if (!container) continue;
    byContainer.set(container, [...(byContainer.get(container) ?? []), target.name]);
  }

  const keep = new Set<string>();
  const failures: string[] = [];

  await Promise.all(
    [...byContainer].map(async ([container, services]) => {
      const outcome = await removeOwnedContainer(container, projectDir);
      handleRemoval('container', container, services, outcome, keep, failures);
    }),
  );

  return { keep, failures };
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
        if (warnOnRefusal && verdict === 'reused') warnReused(target.name, target.info.pid);
        if (warnOnRefusal && verdict === 'unverifiable') warnUnverifiable(target.name, target.info.pid, false);
        if (warnOnRefusal && verdict === 'gone' && group === 'alive') warnOrphanGroup(target.name, target.info.pid);
        results.set(target, { status: 'refused', verdict, group });
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
export async function stopServices(
  projectDir: string,
  serviceNames?: string[],
  options: StopOptions = {},
  hooks: StopHooks = {},
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

  const termRound = await signalRound(probes, targets, 'SIGTERM', true);
  const termed: Target[] = [];

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
      unverified.push(target.name);
      keep.add(target.name);
    }
  }

  // "Gone" is LATCHED the moment it is observed. A group that has exited cannot
  // come back — but its pid can be handed to a stranger a moment later, and
  // re-probing it afterwards would then read as "still running" and turn a
  // completed teardown into a reported failure.
  const confirmedGone = new Set<Target>();
  const observe = (target: Target): boolean => {
    if (confirmedGone.has(target)) return true;
    if (isProcessGroupRunning(probes, target.info.pid)) return false;
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

  return { stopped, unverified, failures, completed, remaining };
}
