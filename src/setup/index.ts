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
 * mode, as entry number `occurrence` of the `total` entries of its list, of
 * any kind, that run the same command. Carrying the total means adding or
 * removing a duplicate of a command invalidates every receipt of that
 * command, so an old receipt is never handed to a newly inserted entry.
 */
export function setupFingerprint(command: string, cwd: string, mode: string, occurrence = 0, total = 1): string {
  return createHash('sha256').update(JSON.stringify({ command, cwd, mode, occurrence, total })).digest('hex');
}

/** A step that keeps a receipt: neither guarded by a path nor marked `always`. */
export function isPlainSetupStep(step: SetupStep): boolean {
  return step.ifMissing === undefined && step.always !== true;
}

/**
 * Fingerprints of the plain steps of one list, in list order; `undefined` for
 * guarded and `always` entries. Identical commands are told apart by their
 * rank among the entries with that command, of any kind, and each fingerprint
 * carries how many such entries the list has. So a receipt stays with its own
 * entry when a neighbour changes kind, and a duplicate inserted before an
 * entry cannot take over its receipt: the count changed, so every entry with
 * that command runs again. Receipts never move between entries.
 */
function plainFingerprints(steps: SetupStep[], cwd: string, mode: string): (string | undefined)[] {
  const totals = new Map<string, number>();
  for (const step of steps) totals.set(step.run, (totals.get(step.run) ?? 0) + 1);
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.run) ?? 0;
    seen.set(step.run, occurrence + 1);
    return isPlainSetupStep(step) ? setupFingerprint(step.run, cwd, mode, occurrence, totals.get(step.run)) : undefined;
  });
}

/**
 * Reconciles the receipts in `mode` with the whole config, not only with the
 * owners of a run: receipts of an owner that is gone (a service that left the
 * config, or one with no steps left in this mode) are dropped, and every live
 * owner keeps only the receipts of steps it still declares. Callers run it
 * before the owners of a run, so a step that left a definition is forgotten
 * even while its owner is not selected, and a service that is removed and
 * later re-added with the same step runs it again. Other modes' receipts are
 * not touched; their step lists are not known here. Writes only when
 * something was dropped. Caller holds the lifecycle lock.
 */
export async function pruneSetupReceipts(config: PortlerConfig, mode: string): Promise<void> {
  const filePath = path.join(portlerDir(config.projectDir), 'setup.json');
  const previous = await readValidatedJsonFile<SetupState>(filePath, 'Portler setup state', isSetupState);
  if (previous?.version !== 2 || previous.project !== config.projectDir) return;
  const owners: [string, SetupStep[] | undefined, string][] = [['project', config.setup, config.projectDir]];
  for (const service of Object.values(config.services)) {
    owners.push([`service:${service.name}`, service.setup, resolveServiceCwd(config, service)]);
  }
  const live = new Map<string, Set<string>>();
  for (const [name, steps, cwd] of owners) {
    if (!steps?.length) continue;
    const current = plainFingerprints(steps, cwd, mode).filter((fingerprint): fingerprint is string => fingerprint !== undefined);
    live.set(`${mode}:${name}`, new Set(current));
  }
  let changed = false;
  for (const [key, recorded] of Object.entries(previous.steps)) {
    if (!key.startsWith(`${mode}:`) || !Array.isArray(recorded)) continue;
    const current = live.get(key);
    if (current === undefined) {
      delete previous.steps[key];
      changed = true;
      continue;
    }
    const kept = recorded.filter((fingerprint) => current.has(fingerprint));
    if (kept.length === recorded.length) continue;
    previous.steps[key] = kept;
    changed = true;
  }
  if (changed) await writeJsonFile(filePath, previous);
}

/**
 * Environment for top-level setup steps: the process env, base `.env` files,
 * then root config env. In production the deployment wins instead: root config
 * env, base `.env` files, then the process env, and a key the deployment
 * supplies is not resolved from config at all (see buildServiceEnv).
 */
export function buildProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments): EnvMap {
  if (config.production) {
    const overridden = new Set([...Object.keys(baseEnv), ...Object.keys(process.env)]);
    return { ...resolveEnvMap(config.env, assignments, overridden), ...baseEnv, ...process.env } as EnvMap;
  }
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
  // rerun cannot leave an old success masking it.
  const fingerprints = plainFingerprints(steps, cwd, mode);
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
    let interrupted = undefined as NodeJS.Signals | undefined;
    const code = await runShell(step.run, cwd, env, { onSignal: (signal) => { interrupted = signal; } });
    // A cancelled step is not a finished step, whatever its exit code: a command that
    // handles SIGTERM and exits 0 must not be receipted, and neither the next step nor
    // the services behind it may run.
    if (interrupted !== undefined) {
      throw new Error(`setup ${name}: interrupted by ${interrupted} while running "${step.run}"; the step is not recorded as done`);
    }
    if (code !== 0) throw new Error(`setup ${name}: command "${step.run}" failed (exit code ${code})`);
    if (fingerprint !== undefined) {
      done.add(fingerprint);
      await persist();
    }
  }
  if (ran === 0) process.stdout.write(`[portler] setup ${name}: nothing to run\n`);
}
