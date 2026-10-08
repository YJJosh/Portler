import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveServiceCwd } from '../config/index.ts';
import { resolveEnvMap } from '../env/resolve.ts';
import { runShell } from '../process/shell.ts';
import { portlerDir } from '../state/index.ts';
import { isObject } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig } from '../types/index.ts';

interface SetupState {
  version: 1;
  project: string;
  steps: Record<string, string>;
}

export function setupFingerprint(commands: string[], cwd: string, mode: string): string {
  return createHash('sha256').update(JSON.stringify({ commands, cwd, mode })).digest('hex');
}

export function buildProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments): EnvMap {
  return { ...process.env, ...baseEnv, ...resolveEnvMap(config.env, assignments) } as EnvMap;
}

/** Caller holds the lifecycle lock; only a fully successful step gets a receipt. */
export async function runSetupStep(
  config: PortlerConfig,
  service: ServiceConfig | null,
  env: EnvMap,
  mode: string,
  force = false,
): Promise<void> {
  const commands = service ? service.setup : config.setup;
  if (!commands?.length) return;
  const cwd = service ? resolveServiceCwd(config, service) : config.projectDir;
  const name = service ? `service:${service.name}` : 'project';
  const key = `${mode}:${name}`;
  const filePath = path.join(portlerDir(config.projectDir), 'setup.json');
  const previous = await readValidatedJsonFile<SetupState>(filePath, 'Portler setup state', (value): value is SetupState =>
    isObject(value) && value.version === 1 && typeof value.project === 'string' &&
    isObject(value.steps) && Object.values(value.steps).every((entry) => typeof entry === 'string'),
  );
  const state: SetupState = previous?.project === config.projectDir ? previous : {
    version: 1, project: config.projectDir, steps: {},
  };
  const fingerprint = setupFingerprint(commands, cwd, mode);
  if (!force && state.steps[key] === fingerprint) {
    process.stdout.write(`[portler] setup ${name}: unchanged, skipping\n`);
    return;
  }
  // A failed forced rerun must not leave an old success masking that failure.
  delete state.steps[key];
  await writeJsonFile(filePath, state);
  for (const command of commands) {
    process.stdout.write(`[portler] setup ${name}: ${command}\n`);
    const code = await runShell(command, cwd, env);
    if (code !== 0) throw new Error(`setup ${name}: command "${command}" failed (exit code ${code})`);
  }
  state.steps[key] = fingerprint;
  await writeJsonFile(filePath, state);
}
