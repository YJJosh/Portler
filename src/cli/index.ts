import { VERSION } from '../constants.ts';
import { isForwardSpec, runForwardSupervisor } from '../k8s/index.ts';
import { parseArgs } from './args.ts';
import type { ParsedArgs } from './args.ts';
import { commandClean } from './commands/clean.ts';
import { commandDown } from './commands/down.ts';
import { commandEnv } from './commands/env.ts';
import { commandInit } from './commands/init.ts';
import { commandK8s } from './commands/k8s.ts';
import { commandLogs } from './commands/logs.ts';
import { commandPorts } from './commands/ports.ts';
import { commandPs } from './commands/ps.ts';
import { commandRestart } from './commands/restart.ts';
import { commandUp } from './commands/up.ts';
import { commandVolumes } from './commands/volumes.ts';
import { printHelp } from './help.ts';

/**
 * Portler's lifecycle is built on POSIX process groups: services are spawned
 * detached so `down` can signal `-pid` and reach the whole tree (a `shell:
 * true` wrapper's grandchildren hold the ports), and stale-pid detection reads
 * the OS process start time. Windows has neither, so a "supported" Windows
 * build would silently leak processes and ports on every `down`. Failing
 * honestly beats pretending — see the Supported platforms section in README.
 */
function ensureSupportedPlatform(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') return;

  throw new Error(
    'Portler supports Linux and macOS only. Its process lifecycle relies on POSIX process groups ' +
      '(so "portler down" can stop a service and everything it spawned) and on OS process start times ' +
      '(so a recycled pid is never signalled) — neither has a safe Windows equivalent today, and a port would ' +
      'leak processes on every "down". Please run Portler under WSL2.',
  );
}

function validateCommandFlags(command: string, args: ParsedArgs): void {
  const used = [
    ...(args.detach ? ['--detach'] : []),
    ...(args.follow ? ['--follow'] : []),
    ...(args.global ? ['--global'] : []),
    ...(args.ports ? ['--ports'] : []),
    ...(args.force ? ['--force'] : []),
    ...(args.volumes ? ['--volumes'] : []),
    ...(args.volumeSet !== undefined ? ['--volume-set'] : []),
    ...(args.file !== undefined ? ['--file'] : []),
  ];
  const allowed: Record<string, ReadonlySet<string>> = {
    up: new Set(['--detach', '--volume-set', '--file']),
    down: new Set(['--force', '--volumes', '--file']),
    restart: new Set(['--volume-set', '--file']),
    clean: new Set(['--global', '--ports', '--force', '--file']),
    ps: new Set(['--file']),
    logs: new Set(['--follow', '--file']),
    ports: new Set(['--file']),
    env: new Set(['--file']),
    volumes: new Set(['--force', '--volume-set', '--file']),
    k8s: new Set(['--file']),
    init: new Set(),
  };
  const commandAllowed = allowed[command];
  if (!commandAllowed) return;

  const unsupported = used.filter((flag) => !commandAllowed.has(flag));
  if (unsupported.length > 0) throw new Error(`${unsupported.join(', ')} ${unsupported.length === 1 ? 'does' : 'do'} not apply to "portler ${command}"`);

  if ((command === 'ports' || command === 'init') && args.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
}

export async function main(rawArgs = process.argv.slice(2)): Promise<number> {
  if (rawArgs.length === 0) {
    printHelp();
    return 0;
  }

  const command = rawArgs[0]!;

  // Hidden internal command: the per-service port-forward supervisor spawned
  // by `up k8s` (see src/k8s/forward-supervisor.ts). Not part of the CLI API.
  if (command === '__k8s-forward') {
    const spec: unknown = JSON.parse(rawArgs[1] ?? 'null');
    if (!isForwardSpec(spec)) throw new Error('__k8s-forward expects a forward spec JSON argument');
    return runForwardSupervisor(spec);
  }

  const args = parseArgs(rawArgs.slice(1), command);

  if (command === '--help' || command === '-h' || args.help) {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // After --help/--version (which must work anywhere, e.g. `npm run smoke`),
  // before anything touches processes or state.
  ensureSupportedPlatform();
  validateCommandFlags(command, args);

  switch (command) {
    case 'up':
      return commandUp(args);
    case 'down':
      return commandDown(args);
    case 'restart':
      return commandRestart(args);
    case 'clean':
      return commandClean(args);
    case 'ps':
      return commandPs(args);
    case 'logs':
      return commandLogs(args);
    case 'ports':
      return commandPorts(args);
    case 'env':
      return commandEnv(args);
    case 'volumes':
      return commandVolumes(args);
    case 'k8s':
      return commandK8s(args);
    case 'init':
      return commandInit();
    case 'help':
      printHelp();
      return 0;
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

export async function runCli(): Promise<void> {
  try {
    const exitCode = await main();
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`[portler] error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
