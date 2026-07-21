import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { resolveServiceCwd } from '../config/index.ts';
import { dockerShellCommand } from './docker.ts';
import { prefixStream } from './logs.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

/** Resolve the concrete shell command used to start a service. */
function serviceCommandFor(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
): string {
  if (service.docker) return dockerShellCommand(config, service, env, explicitEnvKeys, assignment, assignments);
  if (!service.command) throw new Error(`service "${service.name}" has no command`);
  return service.command;
}

/**
 * Spawn a service in its own process group, either streaming prefixed logs to
 * our terminal (foreground) or capturing stdout/stderr into `logFilePath`
 * (detached), so `portler logs` can inspect it later.
 */
export function spawnService(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
  attachLogs: boolean,
  logFilePath?: string,
): ChildProcess {
  const command = serviceCommandFor(config, service, env, explicitEnvKeys, assignment, assignments);
  const cwd = resolveServiceCwd(config, service);

  // The child inherits the file descriptor directly, so log capture keeps
  // working after this process exits and unrefs the detached child. Each
  // start truncates the previous run's log.
  let logFd: number | undefined;
  if (!attachLogs && logFilePath) {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
    logFd = openSync(logFilePath, 'w');
  }

  const child = spawn(command, {
    cwd,
    env,
    shell: true,
    // detached gives the service its own process group so stopServices can
    // signal -pid and take down grandchildren of the shell wrapper — required
    // even in foreground mode, where the child is never unref'd.
    detached: true,
    stdio: attachLogs ? ['ignore', 'pipe', 'pipe'] : ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
  });

  if (logFd !== undefined) closeSync(logFd);

  if (attachLogs) {
    if (child.stdout) prefixStream(service.name, child.stdout, process.stdout);
    if (child.stderr) prefixStream(service.name, child.stderr, process.stderr);
  }

  child.on('error', (error) => {
    process.stderr.write(`[${service.name}] failed to start: ${error.message}\n`);
  });

  if (assignment) {
    process.stdout.write(`[portler] ${service.name}: ${assignment.url} (pid ${child.pid ?? 'unknown'})\n`);
  } else {
    process.stdout.write(`[portler] ${service.name}: started (pid ${child.pid ?? 'unknown'})\n`);
  }

  return child;
}
