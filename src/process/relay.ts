/**
 * Passes a setup step's output on through Portler. A command writing to Portler's closed output gets SIGPIPE; through
 * its own pipe, Portler drops the output instead and the command finishes.
 */
import type { StdioOptions } from 'node:child_process';
import { fstatSync } from 'node:fs';
import type { Socket } from 'node:net';
import type { Readable } from 'node:stream';

const QUIET_MS = 500;
// After a signal: like the 2 s Portler gives a signalled group. Node emits 'drain' only once its whole write buffer is
// out, so a slow reader can go well past QUIET_MS between two.
const STALLED_MS = 2000;
// After the shell exits, its own output left in the pipe and in Node's buffers is far below this: more comes from a
// process it left in the background.
const LEFTOVER_LIMIT = 1024 * 1024;

/** An id for the pipe or socket on `fd`, which a reader can close (`| head`); undefined for a terminal, file or /dev/null. */
export function closablePipe(fd: number): string | undefined {
  try {
    // macOS pipe inodes are kernel addresses, beyond a double's exact range.
    const stats = fstatSync(fd, { bigint: true });
    return stats.isFIFO() || stats.isSocket() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** With `2>&1` both go into one pipe, so the order of stdout and stderr lines stays the same. */
export function relayPlan(command: string, relayOutput: boolean | undefined): { command: string; stdio: StdioOptions } {
  if (!relayOutput) return { command, stdio: 'inherit' };
  const out = closablePipe(1);
  const err = closablePipe(2);
  if (out !== undefined && out === err) return { command: `exec 2>&1\n${command}`, stdio: ['inherit', 'pipe', 'inherit'] };
  return { command, stdio: ['inherit', out ? 'pipe' : 'inherit', err ? 'pipe' : 'inherit'] };
}

export interface Relay {
  stream: Socket;
  closed: Promise<void>;
  bytes(): number;
  /** Paused on a slow reader now, or within the last QUIET_MS. */
  waitingOnReader(): boolean;
  /** Paused, and the reader took nothing for STALLED_MS. */
  stalled(): boolean;
  /** Drops all later output, without waiting on the reader. */
  drop(): void;
}

/** Waits for the reader, as an inherited pipe would. Node never emits 'drain' after a write error on stdout, so an
 * error drops the rest. */
export function relay(from: Readable | null, to: NodeJS.WriteStream): Relay[] {
  if (!from) return [];
  let dropping = false;
  let lastWaited = 0;
  let bytes = 0;
  const drained = (): void => {
    if (!from.isPaused()) return;
    lastWaited = Date.now();
    from.resume();
  };
  const drop = (): void => {
    dropping = true;
    to.off('drain', drained);
    to.off('error', drop);
    from.resume();
  };
  to.on('drain', drained);
  to.on('error', drop);
  from.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (dropping || to.write(chunk)) return;
    from.pause();
    lastWaited = Date.now();
  });
  return [{
    stream: from as Socket,
    closed: new Promise((resolve) => from.once('close', () => {
      drop();
      resolve();
    })),
    bytes: () => bytes,
    waitingOnReader: () => from.isPaused() || Date.now() - lastWaited < QUIET_MS,
    stalled: () => from.isPaused() && Date.now() - lastWaited >= STALLED_MS,
    drop,
  }];
}

/**
 * Called once the shell exited: waits for its last output, also behind a slow reader. A process it left in the
 * background can hold the pipe open and must not keep Portler waiting, so Portler gives up after QUIET_MS without
 * waiting on the reader, after LEFTOVER_LIMIT more bytes, or after `signal` once the reader stalls, and drops what
 * comes later.
 */
export async function finishRelay(command: string, relays: readonly Relay[], signal?: AbortSignal): Promise<void> {
  if (relays.length === 0) return;
  const closed = Promise.all(relays.map((entry) => entry.closed)).then(() => true);
  const atExit = relays.map((entry) => entry.bytes());
  const quiet = (): Promise<false> => new Promise((resolve) => setTimeout(resolve, QUIET_MS, false).unref());
  for (;;) {
    if (await Promise.race([closed, quiet()])) return;
    // A signalled step's last lines are often its cleanup: wait for a slow reader, but not for a stalled one, which
    // would hold the lifecycle lock.
    if (signal?.aborted && relays.some((entry) => entry.stalled())) break;
    const leftover = relays.some((entry, index) => entry.bytes() - atExit[index]! > LEFTOVER_LIMIT);
    if (leftover || !relays.some((entry) => entry.waitingOnReader())) {
      process.stderr.write(`[portler] "${command}" left a process that still holds its output. Portler drops that output, and the process may stop once Portler exits; send its output to a file.\n`);
      break;
    }
  }
  for (const entry of relays) {
    entry.drop();
    entry.stream.unref();
  }
}
