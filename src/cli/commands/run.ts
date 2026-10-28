import { applyProduction, productionServices } from '../../config/production.ts';
import { configForRunMode, loadBaseEnv, loadConfig, resolveServiceCwd, type RunMode } from '../../config/index.ts';
import { buildServiceEnv, envRequirementProblems, hostResolveOptions, resolveEnvValue } from '../../env/index.ts';
import { shellQuote } from '../../process/docker.ts';
import { readPids } from '../../process/index.ts';
import { runForeground } from '../../process/shell.ts';
import { buildProjectEnv } from '../../setup/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import { didYouMean } from '../../util/suggest.ts';
import type { EnvMap, PortlerConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { parseRunMode, recordedRunMode } from '../services.ts';
import { ensureAssignments } from './env.ts';
import { k8sForwardConfig } from './up-k8s.ts';

/** `portler run` with no name: the tasks the config defines. */
function listTasks(config: PortlerConfig): number {
  const tasks = Object.entries(config.tasks ?? {});
  if (tasks.length === 0) {
    process.stdout.write('[portler] no tasks. Define them under "tasks:" in portler.yml, or run "portler run <service> -- <command>".\n');
    return 0;
  }
  const width = Math.max(...tasks.map(([name]) => name.length));
  for (const [name, task] of tasks) {
    const where = task.service ? ` (${task.service})` : '';
    process.stdout.write(`${name.padEnd(width)}  ${task.description ?? task.run}${where}\n`);
  }
  return 0;
}

/**
 * `portler run [docker|k8s] <task|service> [-- <command>...]`: a command on this
 * machine with a service's env (or the project's, with the PORTLER_* values),
 * as that service gets it in the run mode it was last started in, seen from
 * this machine: `${db.address}` is the database's port here. A task runs its
 * own command, whose references resolve first, with the words after `--`
 * appended; a service runs the words after `--`.
 */
export async function commandRun(args: ParsedArgs): Promise<number> {
  // The words after `--` are the command, not names.
  const named = args.passthrough ? args.positionals.slice(0, args.positionals.length - args.passthrough.length) : args.positionals;
  const { mode: requestedMode, requested } = parseRunMode(named);
  const modeExplicit = requested.length < named.length;
  const loadedConfig = await loadConfig(process.cwd(), args.file, { volumeSet: args.volumeSet });
  if (requested.length === 0) {
    if (args.passthrough !== undefined) throw new Error('usage: portler run <task|service> [-- <command>...]');
    return listTasks(loadedConfig);
  }
  if (requested.length > 1) throw new Error(`run takes one task or service name; put the command after "--": portler run ${requested[0]} -- ${requested.slice(1).join(' ')}`);
  const name = requested[0]!;
  const task = loadedConfig.tasks?.[name];
  const serviceName = task ? task.service : name;
  if (!task && !loadedConfig.services[name]) {
    const known = [...Object.keys(loadedConfig.tasks ?? {}), ...Object.keys(loadedConfig.services)];
    throw new Error(`unknown task or service "${name}"${didYouMean(name, known)}. Tasks: ${Object.keys(loadedConfig.tasks ?? {}).join(', ') || '(none)'}.`);
  }
  const extra = args.passthrough ?? [];
  if (!task && extra.length === 0) throw new Error(`"${name}" is a service: put the command to run after "--", e.g. portler run ${name} -- env`);

  const { env, cwd, command } = await withLifecycleLock(loadedConfig.projectDir, async () => {
    // Like `portler env`: a service is seen as it was last started, unless a mode or --prod is typed.
    const recorded = serviceName ? (await readPids(loadedConfig.projectDir))?.services[serviceName] : undefined;
    const recordedMode = recorded && recordedRunMode(configForRunMode(loadedConfig, 'local'), serviceName!, recorded);
    const mode: RunMode = modeExplicit ? requestedMode : recordedMode ?? 'local';
    const prod = args.prod === true || (!modeExplicit && recorded?.prod === true);
    if (mode === 'k8s' && prod) throw new Error('--prod does not apply to k8s mode');
    const runConfig = applyProduction(configForRunMode(productionServices(loadedConfig, prod, serviceName ? [serviceName] : []), mode), prod);
    const { assignments, generatedEnv } = await ensureAssignments(mode === 'k8s' ? k8sForwardConfig(runConfig) : runConfig);
    const baseEnv = await loadBaseEnv(runConfig, { allowMissing: prod });
    // A missing value is reported, not fatal: the command may not need it.
    for (const problem of envRequirementProblems(runConfig, serviceName ? [serviceName] : [], baseEnv, { project: !serviceName })) {
      process.stderr.write(`[portler] warning: ${problem}\n`);
    }
    const service = serviceName ? runConfig.services[serviceName] : undefined;
    const runEnv: EnvMap = service
      ? buildServiceEnv(runConfig, service, baseEnv, generatedEnv, assignments, { viewer: 'host' }).env
      : { ...buildProjectEnv(runConfig, baseEnv, assignments, generatedEnv), ...generatedEnv };
    // A task's command takes references like a healthcheck command: `${db.container}`.
    const resolveOptions = hostResolveOptions(runConfig, service ?? null, baseEnv, generatedEnv, assignments);
    let line: string;
    try {
      line = task ? [resolveEnvValue(task.run, assignments, resolveOptions), ...extra.map(shellQuote)].join(' ') : extra.map(shellQuote).join(' ');
    } catch (error) {
      throw new Error(`tasks.${name}.run: ${(error as Error).message}`);
    }
    return { env: runEnv, cwd: service ? resolveServiceCwd(runConfig, service) : runConfig.projectDir, command: line };
  });
  // The lock is held only while the env is worked out, not while the command runs: a psql
  // session must not block `up` or `down` for this project.
  return runForeground(command, cwd, env);
}
