/**
 * Process identity: a pid alone does not identify a process. Between `portler
 * up` recording a pid and `portler down` signalling it, the original process
 * can exit and the OS can hand the same pid to something unrelated — signalling
 * it would kill a stranger's process (and `kill(-pid)` a stranger's whole
 * process group).
 *
 * So we record a *start token* alongside the pid at spawn time and re-read it
 * before every signal. The token is the kernel's own start-time for that pid,
 * which is fixed for the life of the process and cannot be forged by a process
 * that merely inherited the number.
 *
 * The policy is FAIL-CLOSED: a signal is sent only when the token proves the
 * pid is still ours. "We could not tell" is not permission. A pids.json entry
 * from an older Portler (no token), or one whose token capture failed at spawn,
 * is therefore never signalled — the alternative is best-effort signalling of a
 * pid we cannot identify, which is exactly how a long-lived legacy entry ends
 * up killing whatever unrelated process later inherits that number.
 */
import fs from 'node:fs/promises';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';

/** How the recorded identity compares to whatever currently holds the pid. */
export type IdentityVerdict =
  /** Same process we started — safe to signal. */
  | 'match'
  /** The pid is held by a different process now — must NOT be signalled. */
  | 'reused'
  /** Nothing holds the pid (already exited) — nothing to signal. */
  | 'gone'
  /**
   * The pid is live but its identity cannot be established: a legacy entry with
   * no recorded token, a token capture that failed at spawn, or a platform that
   * will not report the current token. Must NOT be signalled.
   */
  | 'unverifiable';

/**
 * Decide whether a recorded pid may be signalled. Pure, so the policy is
 * testable without spawning anything.
 *
 * - pid not live                -> 'gone'          (nothing to do)
 * - no recorded token           -> 'unverifiable'  (legacy entry / failed capture)
 * - no current token, live pid  -> 'unverifiable'  (platform will not say who it is)
 * - tokens equal               -> 'match'
 * - tokens differ              -> 'reused'         (the OS recycled the number)
 */
export function identityVerdict(
  recordedToken: string | undefined,
  currentToken: string | null,
  pidExists: boolean,
): IdentityVerdict {
  if (!pidExists) return 'gone';
  if (recordedToken === undefined) return 'unverifiable';
  if (currentToken === null) return 'unverifiable';

  return recordedToken === currentToken ? 'match' : 'reused';
}

/**
 * True when the verdict permits sending a signal to the pid. ONLY a proven
 * match does. Anything else — including "we cannot tell" — does not.
 */
export function maySignal(verdict: IdentityVerdict): boolean {
  return verdict === 'match';
}

/**
 * Linux: /proc/<pid>/stat field 22 is the process start time in clock ticks
 * since boot — constant for the process's life, and distinct for any process
 * that started at a different tick (100 Hz or better). The comm field (2) is
 * wrapped in parentheses and may itself contain spaces and parens, so fields
 * are counted from the LAST ')'.
 */
async function readLinuxStartToken(pid: number): Promise<string | null> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }

  const commEnd = stat.lastIndexOf(')');
  if (commEnd === -1) return null;

  // Fields after comm start at field 3 (state), so field 22 is index 19 here.
  const fields = stat.slice(commEnd + 1).trim().split(/\s+/);
  const startTime = fields[19];

  return startTime && /^\d+$/.test(startTime) ? startTime : null;
}

/**
 * macOS has no /proc, so the start time comes from `ps`. Two fields are used:
 *
 * - `lstart`: the absolute start time, but only to the SECOND. On its own that
 *   is a weaker token than Linux's clock ticks.
 * - `pgid`: the process-group id, which for a Portler-spawned service is its
 *   own pid (spawn is detached, so the child leads a new process group). A
 *   process that later inherits the pid has pgid <pid> only if it, too, is a
 *   process-group leader. (`ps`'s `sess` field is a kernel session pointer on
 *   macOS and can be reported as zero, so it is not an identity discriminator.)
 *
 * Together they narrow "same pid, same whole second" further, but the honest
 * claim is bounded: on macOS the token proves identity up to a process that
 * took the same recycled pid within the same second AND leads its own process
 * group. Pid reuse requires the pid counter to wrap first, so this is a small
 * residual risk, not an eliminated one — and it is documented as such in
 * docs/reference.
 *
 * `ps` output for a nonexistent pid is empty with a non-zero exit, which we map
 * to null (caller has already established liveness separately).
 */
export function darwinPsArgs(pid: number): string[] {
  return ['-o', 'lstart=,pgid=', '-p', String(pid)];
}

/** Pure parser for the `ps` output above, so it is testable off a Mac. */
export function parseDarwinStartToken(code: number, stdout: string): string | null {
  if (code !== 0) return null;

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  // More than one row means we did not identify a single process; refuse rather
  // than pick one (the caller then treats the pid as unverifiable).
  if (lines.length !== 1) return null;

  // Collapse ps's column padding so the token is stable across `ps` versions.
  const token = lines[0]!.replace(/\s+/g, ' ');

  return token === '' ? null : token;
}

async function readDarwinStartToken(pid: number, run: CommandRunner): Promise<string | null> {
  const result = await run('ps', darwinPsArgs(pid));
  return parseDarwinStartToken(result.code, result.stdout);
}

/**
 * The start token for a live pid, or null when the pid does not exist (or the
 * platform cannot report it). Portler supports Linux and macOS only; on any
 * other platform this returns null, which — under the fail-closed policy above
 * — means Portler will refuse to signal recorded pids rather than guess.
 */
export async function readProcessStartToken(pid: number, run: CommandRunner = runCommand): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') return readLinuxStartToken(pid);
  if (process.platform === 'darwin') return readDarwinStartToken(pid, run);

  return null;
}
