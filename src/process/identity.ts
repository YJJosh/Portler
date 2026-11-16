/**
 * The OS can hand a recorded pid to a stranger, and `kill(-pid)` would kill their group, so
 * a start token (the kernel's start time) is recorded at spawn and re-read before every signal.
 * Fail-closed: only a matching token permits a signal; no token or a failed capture never does.
 */
import fs from 'node:fs/promises';
import { runCommand } from '../util/exec.ts';
import type { CommandRunner } from '../util/exec.ts';

export type IdentityVerdict =
  /** The process Portler started: safe to signal. */
  | 'match'
  /** A different process holds the pid: never signal it. */
  | 'reused'
  /** Nothing holds the pid. */
  | 'gone'
  /** Live, but no recorded token, a failed capture, or a platform without tokens. Never signal it. */
  | 'unverifiable';

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

/** Only a proven match permits a signal; "cannot tell" does not. */
export function maySignal(verdict: IdentityVerdict): boolean {
  return verdict === 'match';
}

// Linux: /proc/<pid>/stat field 22 is the start time in clock ticks since boot. comm
// (field 2) may contain spaces and parens, so count from the last ')'.
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
 * macOS `ps`: `lstart` is only to the second, so `pgid` is added (`sess` can read as zero). Reuse
 * within that second by another group leader still matches: a residual risk, see docs/reference.
 */
export function darwinPsArgs(pid: number): string[] {
  return ['-o', 'lstart=,pgid=', '-p', String(pid)];
}

export function parseDarwinStartToken(code: number, stdout: string): string | null {
  if (code !== 0) return null;

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  // Not exactly one process: refuse rather than pick one.
  if (lines.length !== 1) return null;

  // Collapse ps's column padding so the token is stable across `ps` versions.
  const token = lines[0]!.replace(/\s+/g, ' ');

  return token === '' ? null : token;
}

async function readDarwinStartToken(pid: number, run: CommandRunner): Promise<string | null> {
  const result = await run('ps', darwinPsArgs(pid));
  return parseDarwinStartToken(result.code, result.stdout);
}

/** Null when the pid does not exist or the platform is not Linux or macOS (never signalled there). */
export async function readProcessStartToken(pid: number, run: CommandRunner = runCommand): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  if (process.platform === 'linux') return readLinuxStartToken(pid);
  if (process.platform === 'darwin') return readDarwinStartToken(pid, run);

  return null;
}
