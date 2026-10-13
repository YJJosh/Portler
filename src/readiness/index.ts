import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from '../constants.ts';
import { resolveServiceCwd } from '../config/index.ts';
import { resolveEnvValue } from '../env/index.ts';
import { sleep } from '../util/sleep.ts';
import type { Assignments, EnvMap, HealthcheckConfig, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

/**
 * Docker's port proxy accepts every connection on a published port, then
 * closes it straight away while nothing listens inside the container yet.
 * A container port only counts as ready once a connection stays open for
 * this long, or once the peer sends something: the proxy never sends data.
 */
export const DOCKER_TCP_HOLD_MS = 200;

export function isTcpReady(host: string, port: number, timeoutMs = 1_000, holdMs = 0): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let holdTimer: NodeJS.Timeout | undefined;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const socket = net.createConnection({ host, port });
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(holdTimer);
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(Math.max(1, timeoutMs));
    socket.on('connect', () => {
      if (holdMs <= 0) return finish(true);
      socket.setTimeout(0);
      // Bytes from the peer prove a real listener even if it hangs up right
      // after (a banner, a protocol that answers and closes): Docker's proxy
      // never sends application data. Attaching the listener also drains the
      // socket, so a silent peer close is noticed rather than buffered.
      socket.once('data', () => finish(true));
      // A silent peer has to stay open for the whole hold, and the hold must
      // end inside this attempt's deadline. A connect that lands with less than
      // the hold left still gets the time that is left for the peer to answer;
      // if it stays silent until then it is not ready yet, and the caller
      // decides whether its overall timeout leaves room for another attempt.
      const remaining = deadline - Date.now();
      const fullHoldFits = remaining > holdMs;
      // Checked again when the timer fires: a blocked event loop can delay
      // it past the deadline, and a hold that ended late has proved nothing
      // in time.
      holdTimer = setTimeout(() => finish(fullHoldFits && Date.now() <= deadline), Math.min(holdMs, Math.max(1, remaining)));
    });
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function isHttpReady(url: string, timeoutMs: number, accept?: number[]): Promise<boolean> {
  try {
    // A 2xx or 3xx response proves the app answered the request. redirect:
    // 'manual' returns 3xx responses directly (passing the check) instead of
    // following them to another host. A 401 or 404 means the server is up but
    // the route or the credentials are not, so it does not count unless the
    // config lists it in `accept`. A server that accepts and never responds
    // must not defeat the overall healthcheck timeout, so every fetch has an
    // explicit remaining-time signal.
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return accept ? accept.includes(response.status) : response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

function isCommandReady(command: string, cwd: string, env: EnvMap, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: 'ignore',
      // A healthcheck may spawn children of its own. Put it in a separate group
      // so timing out can clean the whole probe rather than leak grandchildren.
      detached: true,
    });

    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ready);
    };

    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // It exited between the timeout and the signal.
        }
      } else {
        child.kill('SIGKILL');
      }
      finish(false);
    }, Math.max(1, timeoutMs));

    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

function defaultHealthcheck(service: ServiceConfig, assignment: ServiceAssignment | undefined): HealthcheckConfig {
  const type = !assignment || service.port === undefined ? 'none' : 'tcp';
  return { type, timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS, intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS };
}

async function checkReady(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  assignments: Assignments,
  assignment: ServiceAssignment | undefined,
  healthcheck: HealthcheckConfig,
  attemptTimeoutMs: number,
  tcpHoldMs: number,
): Promise<boolean> {
  switch (healthcheck.type) {
    case 'none':
      return true;
    case 'tcp':
      if (!assignment) return true;
      return isTcpReady(assignment.host, assignment.port, attemptTimeoutMs, tcpHoldMs);
    case 'http': {
      const url = healthcheck.url ? resolveEnvValue(healthcheck.url, assignments) : assignment?.url;
      if (!url) return true;
      return isHttpReady(url, attemptTimeoutMs, healthcheck.accept);
    }
    case 'command': {
      if (!healthcheck.command) throw new Error(`service "${service.name}" healthcheck command is missing`);
      const command = resolveEnvValue(healthcheck.command, assignments);
      return isCommandReady(command, resolveServiceCwd(config, service), env, attemptTimeoutMs);
    }
  }
}

/** Human-readable summary of what a healthcheck actually probes, for timeout errors. */
function describeHealthcheck(
  healthcheck: HealthcheckConfig,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
): string {
  switch (healthcheck.type) {
    case 'tcp':
      return assignment ? `tcp check on ${assignment.host}:${assignment.port}` : 'tcp check';
    case 'http': {
      const url = healthcheck.url ? resolveEnvValue(healthcheck.url, assignments) : assignment?.url;
      return url ? `http check on ${url}` : 'http check';
    }
    case 'command':
      return healthcheck.command ? `command check "${healthcheck.command}"` : 'command check';
    default:
      return 'readiness check';
  }
}

/**
 * Where a service's output went, for error messages: on this terminal when
 * `logFile` is undefined, otherwise in the detached log file.
 */
export function logLocationHint(serviceName: string, logFile: string | undefined): string {
  return logFile === undefined
    ? `Check the "[${serviceName}]" log lines above for the cause`
    : `Check ${logFile} (or "portler logs ${serviceName}") for the cause`;
}

const PORTLER_ERROR_PREFIX = '[portler] error: ';
const MAX_LOG_REASONS = 3;
const MAX_LOG_REASON_LENGTH = 500;
const LOG_READ_CHUNK = 64 * 1024;
const LOG_TAIL_BYTES = 1024 * 1024;

/**
 * Portler's own refusals from a detached service's log. The launch shell
 * builds the image first and then checks the network, volumes and container
 * name, exiting at the first one that is not this project's, so a refusal is
 * the last thing it writes, after any build output. The log is truncated on
 * every start, so these lines belong to this run. A foreground run already
 * shows them above.
 *
 * Only the last MiB the log held when the scan started is read, 64 KiB at a
 * time: a long build costs nothing beyond that, and a process left behind
 * that keeps appending cannot keep the scan going. At most the start of one
 * line and the last three refusals are held.
 */
export function portlerErrorsInLog(logFile: string): string[] {
  let fd: number;
  try {
    fd = openSync(logFile, 'r');
  } catch {
    return [];
  }
  const reasons: string[] = [];
  const keep = PORTLER_ERROR_PREFIX.length + MAX_LOG_REASON_LENGTH;
  let line = '';
  let cut = false;
  const append = (piece: string) => {
    if (line.length + piece.length <= keep) {
      line += piece;
    } else {
      line += piece.slice(0, keep - line.length);
      cut = true;
    }
  };
  const endLine = () => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (text.startsWith(PORTLER_ERROR_PREFIX)) {
      const reason = text.slice(PORTLER_ERROR_PREFIX.length).trim();
      if (reason !== '') reasons.push(cut ? `${reason}…` : reason);
      if (reasons.length > MAX_LOG_REASONS) reasons.shift();
    }
    line = '';
    cut = false;
  };
  try {
    const end = fstatSync(fd).size;
    // A window that starts inside a line drops that line: read from one byte
    // earlier and discard through the first newline, which is that byte when
    // the window starts on a line of its own.
    let position = end > LOG_TAIL_BYTES ? end - LOG_TAIL_BYTES - 1 : 0;
    let skipping = position > 0;
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(LOG_READ_CHUNK);
    while (position < end) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
      if (read === 0) break;
      position += read;
      const text = decoder.write(buffer.subarray(0, read));
      let from = 0;
      if (skipping) {
        const newline = text.indexOf('\n');
        if (newline === -1) continue;
        skipping = false;
        from = newline + 1;
      }
      for (let newline = text.indexOf('\n', from); newline !== -1; newline = text.indexOf('\n', from)) {
        append(text.slice(from, newline));
        endLine();
        from = newline + 1;
      }
      append(text.slice(from));
    }
    if (!skipping) {
      append(decoder.end());
      endLine();
    }
    return reasons;
  } catch {
    return reasons;
  } finally {
    closeSync(fd);
  }
}

function exitedError(service: ServiceConfig, logFile: string | undefined): Error {
  const buildHint = service.docker?.build ? ' (this includes "docker build" failures)' : '';
  const reasons = logFile === undefined ? [] : portlerErrorsInLog(logFile);
  // "The same command": a bare `up <name>` would drop the mode and flags the
  // stack was started with.
  if (reasons.length > 0) {
    return new Error(
      `service "${service.name}" exited before it became ready: ${reasons.join(' ')} ` +
        `The full output is in ${logFile} (or "portler logs ${service.name}"); fix that, then run the same command again.`,
    );
  }
  return new Error(
    `service "${service.name}" exited before it became ready. ${logLocationHint(service.name, logFile)}${buildHint}, then run the same command again.`,
  );
}

/**
 * Poll a service's healthcheck until it passes, the configured timeout
 * elapses, or the child process exits early.
 */
export async function waitForServiceReady(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  assignments: Assignments,
  assignment: ServiceAssignment | undefined,
  childHasExited: () => boolean,
  /** How long a TCP connection must stay open to count; see DOCKER_TCP_HOLD_MS. */
  tcpHoldMs = 0,
  /** The detached log file of the service, named in errors; undefined when its output is on this terminal. */
  logFile?: string,
): Promise<void> {
  const healthcheck = service.healthcheck ?? defaultHealthcheck(service, assignment);
  if (healthcheck.type === 'none') return;

  const startedAt = Date.now();
  process.stdout.write(`[portler] waiting for ${service.name} to be ready (${healthcheck.type})...\n`);

  while (Date.now() - startedAt <= healthcheck.timeoutMs) {
    if (childHasExited()) throw exitedError(service, logFile);

    const remainingMs = Math.max(1, healthcheck.timeoutMs - (Date.now() - startedAt));
    const ready = await checkReady(config, service, env, assignments, assignment, healthcheck, remainingMs, tcpHoldMs);
    // The probe can pass against a port whose process died while it ran: Docker's
    // proxy keeps accepting, a hold timer keeps ticking. The exit wins.
    if (childHasExited()) throw exitedError(service, logFile);
    if (ready) {
      process.stdout.write(`[portler] ${service.name} is ready\n`);
      return;
    }

    const remainingAfterCheck = healthcheck.timeoutMs - (Date.now() - startedAt);
    if (remainingAfterCheck > 0) await sleep(Math.min(healthcheck.intervalMs, remainingAfterCheck));
  }

  throw new Error(
    `service "${service.name}" was not ready after ${Math.round(healthcheck.timeoutMs / 1000)}s ` +
      `(${describeHealthcheck(healthcheck, assignment, assignments)}). ` +
      `If the service just needs more time, raise services.${service.name}.healthcheck.timeout_ms; otherwise fix the check or the service.`,
  );
}
