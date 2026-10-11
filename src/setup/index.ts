import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveServiceCwd } from '../config/index.ts';
import { resolveEnvMap } from '../env/resolve.ts';
import { runShell } from '../process/shell.ts';
import { portlerDir } from '../state/index.ts';
import { pathExists } from '../util/fs.ts';
import { isObject } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig, SetupStep } from '../types/index.ts';

/**
 * Receipts of the plain setup steps that succeeded in this checkout, keyed by
 * run mode and step owner (`local:dev:project`, `local:prod:service:api`).
 * Version 1 kept one fingerprint per owner for the whole command list; a file
 * in that shape is accepted and treated as empty, so the steps run once more.
 */
interface SetupState {
  version: 1 | 2;
  project: string;
  steps: Record<string, string | string[]>;
}

function isSetupState(value: unknown): value is SetupState {
  if (!isObject(value) || typeof value.project !== 'string' || !isObject(value.steps)) return false;
  if (value.version === 1) return Object.values(value.steps).every((entry) => typeof entry === 'string');
  if (value.version === 2) {
    return Object.values(value.steps).every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === 'string'));
  }
  return false;
}

/**
 * What a plain step's receipt stands for: this command, in this cwd, in this
 * mode; `occurrence` tells identical commands in one list apart (0 for the
 * first).
 */
export function setupFingerprint(command: string, cwd: string, mode: string, occurrence = 0): string {
  return createHash('sha256').update(JSON.stringify({ command, cwd, mode, occurrence })).digest('hex');
}

/** A step that keeps a receipt: neither guarded by a path nor marked `always`. */
export function isPlainSetupStep(step: SetupStep): boolean {
  return step.ifMissing === undefined && step.always !== true;
}

export function buildProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments): EnvMap {
  return { ...process.env, ...baseEnv, ...resolveEnvMap(config.env, assignments) } as EnvMap;
}

/**
 * Runs the setup steps of the project (service null) or of one service, in
 * order. Per step:
 *
 * - `if_missing`: skipped while something exists at the path (resolved
 *   against the step's cwd); runs otherwise. The path is the receipt, so
 *   `force` does not override it.
 * - `always`: runs every time.
 * - plain: runs once per checkout; again when its command or cwd changed, or
 *   with `force`. Each success is written to `.portler/setup.json` right away,
 *   so a later failure does not make the earlier steps run again.
 *
 * The first failure stops the run. Caller holds the lifecycle lock.
 */
export async function runSetupStep(
  config: PortlerConfig,
  service: ServiceConfig | null,
  env: EnvMap,
  mode: string,
  force = false,
): Promise<void> {
  const steps = service ? service.setup : config.setup;
  const name = service ? `service:${service.name}` : 'project';
  const key = `${mode}:${name}`;
  const filePath = path.join(portlerDir(config.projectDir), 'setup.json');
  const previous = await readValidatedJsonFile<SetupState>(filePath, 'Portler setup state', isSetupState);
  if (!steps?.length) {
    // A definition that lost its steps loses their receipts too, so a step
    // that comes back later runs again instead of looking already done.
    if (previous?.version === 2 && previous.project === config.projectDir && previous.steps[key] !== undefined) {
      delete previous.steps[key];
      await writeJsonFile(filePath, previous);
    }
    return;
  }
  const cwd = service ? resolveServiceCwd(config, service) : config.projectDir;
  const state: SetupState & { version: 2; steps: Record<string, string[]> } =
    previous?.project === config.projectDir && previous.version === 2
      ? (previous as SetupState & { version: 2; steps: Record<string, string[]> })
      : { version: 2, project: config.projectDir, steps: {} };

  // Receipts of steps that are no longer defined are dropped, and a forced
  // run drops every receipt BEFORE anything runs, so a failure in a forced
  // rerun cannot leave an old success masking it. Identical commands in one
  // list are separate steps: the receipt carries the occurrence.
  const seen = new Map<string, number>();
  const fingerprints = steps.map((step) => {
    if (!isPlainSetupStep(step)) return undefined;
    const occurrence = seen.get(step.run) ?? 0;
    seen.set(step.run, occurrence + 1);
    return setupFingerprint(step.run, cwd, mode, occurrence);
  });
  const recorded = force ? new Set<string>() : new Set(state.steps[key] ?? []);
  const done = new Set(fingerprints.filter((fingerprint): fingerprint is string => fingerprint !== undefined && recorded.has(fingerprint)));
  const persist = async (): Promise<void> => {
    state.steps[key] = [...done];
    await writeJsonFile(filePath, state);
  };
  if (previous !== state || done.size !== (state.steps[key] ?? []).length) await persist();

  let ran = 0;
  for (const [index, step] of steps.entries()) {
    if (step.ifMissing !== undefined && (await pathExists(path.resolve(cwd, step.ifMissing)))) {
      process.stdout.write(`[portler] setup ${name}: skip ${step.run} (${step.ifMissing} exists)\n`);
      continue;
    }
    const fingerprint = fingerprints[index];
    if (fingerprint !== undefined && done.has(fingerprint)) continue;

    process.stdout.write(`[portler] setup ${name}: ${step.run}\n`);
    ran += 1;
    const code = await runShell(step.run, cwd, env);
    if (code !== 0) throw new Error(`setup ${name}: command "${step.run}" failed (exit code ${code})`);
    if (fingerprint !== undefined) {
      done.add(fingerprint);
      await persist();
    }
  }
  if (ran === 0) process.stdout.write(`[portler] setup ${name}: nothing to run\n`);
}
