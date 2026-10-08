import { spawn } from 'node:child_process';
import net from 'node:net';
import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from '../constants.ts';
import { resolveServiceCwd } from '../config/index.ts';
import { resolveEnvValue } from '../env/index.ts';
import { sleep } from '../util/sleep.ts';
import type { Assignments, EnvMap, HealthcheckConfig, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

/**
 * Docker's port proxy accepts every connection on a published port, then
 * closes it straight away while nothing listens inside the container yet.
 * A container port only counts as ready once a connection stays open.
 */
export const DOCKER_TCP_HOLD_MS = 200;

export function isTcpReady(host: string, port: number, timeoutMs = 1_000, holdMs = 0): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let holdTimer: NodeJS.Timeout | undefined;
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
      // Drain any banner so a peer close is noticed rather than buffered.
      socket.resume();
      holdTimer = setTimeout(() => finish(true), holdMs);
    });
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

async function isHttpReady(url: string, timeoutMs: number): Promise<boolean> {
  try {
    // Any response below 500 proves the server is up and routing requests —
    // 404/401 still count as ready. redirect: 'manual' returns 3xx responses
    // directly (passing the check) instead of following them to another host.
    // A server that accepts and never responds must not defeat the overall
    // healthcheck timeout, so every fetch has an explicit remaining-time signal.
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return response.status < 500;
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
      return isHttpReady(url, attemptTimeoutMs);
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
): Promise<void> {
  const healthcheck = service.healthcheck ?? defaultHealthcheck(service, assignment);
  if (healthcheck.type === 'none') return;

  const startedAt = Date.now();
  process.stdout.write(`[portler] waiting for ${service.name} to be ready (${healthcheck.type})...\n`);

  while (Date.now() - startedAt <= healthcheck.timeoutMs) {
    if (childHasExited()) {
      const buildHint = service.docker?.build ? ' (this includes "docker build" failures)' : '';
      throw new Error(
        `service "${service.name}" exited before it became ready. ` +
          `Check the "[${service.name}]" log lines above for the cause${buildHint}, then run "portler up ${service.name}" again.`,
      );
    }

    const remainingMs = Math.max(1, healthcheck.timeoutMs - (Date.now() - startedAt));
    if (await checkReady(config, service, env, assignments, assignment, healthcheck, remainingMs, tcpHoldMs)) {
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
