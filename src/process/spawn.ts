import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import { resolveServiceCwd } from '../config/index.ts';
import { dockerShellCommand } from './docker.ts';
import { openServiceLog, prefixStream } from './logs.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

function serviceCommandFor(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
  baseEnv: EnvMap,
): string {
  if (service.docker) return dockerShellCommand(config, service, env, explicitEnvKeys, assignment, assignments, baseEnv);
  if (!service.command) throw new Error(`service "${service.name}" has no command`);
  return service.command;
}

/** Spawns in its own process group; streams prefixed logs (`attachLogs`) or writes `logFilePath`. */
export function spawnService(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
  attachLogs: boolean,
  logFilePath?: string,
  // Lets build-arg exports keep use_env values.
  baseEnv: EnvMap = {},
): ChildProcess {
  const command = serviceCommandFor(config, service, env, explicitEnvKeys, assignment, assignments, baseEnv);
  const cwd = resolveServiceCwd(config, service);

  // The child inherits the fd, so capture keeps working after Portler exits.
  let logFd: number | undefined;
  if (!attachLogs && logFilePath) {
    logFd = openServiceLog(logFilePath);
  }

  const child = spawn(command, {
    cwd,
    env,
    shell: true,
    // Its own process group, so stopServices can signal -pid and reach the shell's grandchildren.
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
