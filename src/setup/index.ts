import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { assertServiceCwd, resolveServiceCwd } from '../config/index.ts';
import { composeProjectEnv } from '../env/index.ts';
import { runShell } from '../process/shell.ts';
import { portlerDir } from '../state/index.ts';
import { pathExists } from '../util/fs.ts';
import { isObject } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig, SetupStep } from '../types/index.ts';

// Receipts of succeeded plain steps by mode and owner (`local:prod:service:api`): the fingerprint, plus `:` and the
// watch digest for a `watch` step. A version 1 file (one fingerprint per owner) is read as empty.
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

/** Includes the volume set when the project has managed volumes: a migration that ran against one set's
 * database has not run against another's. */
export function setupModeKey(config: PortlerConfig, mode: string, prod?: boolean): string {
  const set = config.volumeSet && config.volumes.length > 0 ? `@${config.volumeSet}` : '';
  return `${mode}:${prod ? 'prod' : 'dev'}${set}`;
}

/** `occurrence` ranks the entry among the `total` entries of its list with the same command. With the total included,
 * adding or removing a duplicate invalidates every receipt of that command, so none moves to a new entry. */
export function setupFingerprint(command: string, cwd: string, mode: string, occurrence = 0, total = 1, watch?: string): string {
  const identity = watch === undefined ? { command, cwd, mode, occurrence, total } : { command, cwd, mode, occurrence, total, watch };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

// Null when nothing exists at the path. Symlinks in a folder count by their target path and are not
// followed, so a link loop cannot hang the walk.
function pathDigest(filePath: string, label: string): string | null {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(filePath).isDirectory();
  } catch (error) {
    // An unreadable path (EACCES) must not pass for a missing one and skip the step.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new Error(`watch path "${label}" cannot be read: ${(error as Error).message}`);
  }
  try {
    return isDirectory ? folderDigest(filePath) : createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch (error) {
    throw new Error(`watch path "${label}" cannot be read: ${(error as Error).message}`);
  }
}

function folderDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string, relative: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) hash.update(JSON.stringify(['link', name, readlinkSync(full)]));
      else if (entry.isDirectory()) {
        hash.update(JSON.stringify(['dir', name]));
        walk(full, name);
      } else if (entry.isFile()) {
        hash.update(JSON.stringify(['file', name, createHash('sha256').update(readFileSync(full)).digest('hex')]));
      }
    }
  };
  walk(root, '');
  return `dir:${hash.digest('hex')}`;
}

// One [path, digest-or-null] record per watch path, so no content can pass for absence or another path's entry.
function watchDigest(step: SetupStep, cwd: string): string | undefined {
  if (!step.watch) return undefined;
  const records = step.watch.map((file) => [file, pathDigest(path.resolve(cwd, file), file)]);
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

/** A step that keeps a receipt. */
export function isPlainSetupStep(step: SetupStep): boolean {
  return step.ifMissing === undefined && step.always !== true;
}

function receiptIdentity(receipt: string): string {
  return receipt.split(':', 1)[0];
}

// In list order, `undefined` for guarded and `always` entries. Ranks count every entry, so a receipt stays
// with its entry when a neighbour changes kind. Watch digests are taken when the step is reached.
function plainIdentities(steps: SetupStep[], cwd: string, mode: string): (string | undefined)[] {
  const totals = new Map<string, number>();
  for (const step of steps) totals.set(step.run, (totals.get(step.run) ?? 0) + 1);
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const occurrence = seen.get(step.run) ?? 0;
    seen.set(step.run, occurrence + 1);
    return isPlainSetupStep(step) ? setupFingerprint(step.run, cwd, mode, occurrence, totals.get(step.run)) : undefined;
  });
}

/** Drops `mode` receipts of steps the whole config (unselected owners too) no longer declares, so a removed and
 * re-added step runs again. Writes only when something was dropped. Caller holds the lifecycle lock. */
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
    const current = plainIdentities(steps, cwd, mode).filter((identity): identity is string => identity !== undefined);
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
    const kept = recorded.filter((receipt) => current.has(receiptIdentity(receipt)));
    if (kept.length === recorded.length) continue;
    previous.steps[key] = kept;
    changed = true;
  }
  if (changed) await writeJsonFile(filePath, previous);
}

/** Drops the active volume set's receipts before a managed volume is created empty; returns whether any were dropped.
 * Caller holds the lifecycle lock. */
export async function forgetVolumeSetupReceipts(config: PortlerConfig): Promise<boolean> {
  // Without name:, dev and prod share volumes, so both lose their receipts; with it, only the current one.
  const productions = config.name ? [config.production === true] : [false, true];
  const modes = productions.flatMap((prod) => (['local', 'docker'] as const).map((mode) => setupModeKey(config, mode, prod)));
  const filePath = path.join(portlerDir(config.projectDir), 'setup.json');
  const previous = await readValidatedJsonFile<SetupState>(filePath, 'Portler setup state', isSetupState);
  if (!previous || previous.project !== config.projectDir) return false;
  let changed = false;
  for (const key of Object.keys(previous.steps)) {
    if (!modes.some((mode) => key.startsWith(`${mode}:`))) continue;
    delete previous.steps[key];
    changed = true;
  }
  if (changed) await writeJsonFile(filePath, previous);
  return changed;
}

/** Env for top-level setup steps: `default:` entries, process env, base `.env` files, then root config env. In production
 * the deployment wins: config env, `.env` files, then process env, and keys it supplies skip config (see buildServiceEnv). */
export function buildProjectEnv(config: PortlerConfig, baseEnv: EnvMap, assignments: Assignments, generatedEnv: EnvMap = {}): EnvMap {
  return composeProjectEnv(config, baseEnv, assignments, generatedEnv).env;
}

/** Runs the project's (service null) or one service's steps in order until one fails (step kinds: docs/reference/configuration.md).
 * `force` reruns plain steps, not `if_missing`. Each success is written to `.portler/setup.json` at once. Caller holds the lifecycle lock. */
export async function runSetupStep(
  config: PortlerConfig,
  service: ServiceConfig | null,
  env: EnvMap,
  mode: string,
  force = false,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const steps = service ? service.setup : config.setup;
  const name = service ? `service:${service.name}` : 'project';
  const key = `${mode}:${name}`;
  const filePath = path.join(portlerDir(config.projectDir), 'setup.json');
  const previous = await readValidatedJsonFile<SetupState>(filePath, 'Portler setup state', isSetupState);
  if (!steps?.length) {
    // Forget its receipts, so a step that comes back later runs again.
    if (previous?.version === 2 && previous.project === config.projectDir && previous.steps[key] !== undefined) {
      delete previous.steps[key];
      await writeJsonFile(filePath, previous);
    }
    return;
  }
  if (service) assertServiceCwd(config, service);
  const cwd = service ? resolveServiceCwd(config, service) : config.projectDir;
  const state: SetupState & { version: 2; steps: Record<string, string[]> } =
    previous?.project === config.projectDir && previous.version === 2
      ? (previous as SetupState & { version: 2; steps: Record<string, string[]> })
      : { version: 2, project: config.projectDir, steps: {} };

  // A forced run drops every receipt before anything runs, so a failed rerun cannot leave an old success standing.
  const identities = plainIdentities(steps, cwd, mode);
  const live = new Set(identities.filter((identity): identity is string => identity !== undefined));
  const recorded = force ? [] : (state.steps[key] ?? []).filter((receipt) => live.has(receiptIdentity(receipt)));
  const done = new Map(recorded.map((receipt) => [receiptIdentity(receipt), receipt]));
  const persist = async (): Promise<void> => {
    state.steps[key] = [...done.values()];
    await writeJsonFile(filePath, state);
  };
  if (previous !== state || done.size !== (state.steps[key] ?? []).length) await persist();
  const receiptFor = (step: SetupStep, identity: string): string => {
    try {
      return step.watch ? `${identity}:${watchDigest(step, cwd)}` : identity;
    } catch (error) {
      throw new Error(`setup ${name}: ${(error as Error).message}`);
    }
  };

  let ran = 0;
  for (const [index, step] of steps.entries()) {
    if (step.ifMissing !== undefined && (await pathExists(path.resolve(cwd, step.ifMissing)))) {
      process.stdout.write(`[portler] setup ${name}: skip ${step.run} (${step.ifMissing} exists)\n`);
      continue;
    }
    const identity = identities[index];
    if (identity !== undefined) {
      if (done.get(identity) === receiptFor(step, identity)) continue;
      // Drop an outdated receipt first, so a failed rerun cannot leave it standing.
      if (done.delete(identity)) await persist();
    }

    signal?.throwIfAborted();
    process.stdout.write(`[portler] setup ${name}: ${step.run}\n`);
    ran += 1;
    let interrupted = undefined as NodeJS.Signals | undefined;
    const code = await runShell(step.run, cwd, env, { signal, relayOutput: true, onSignal: (signal) => { interrupted = signal; } });
    // A cancelled step is not done even if it handled SIGTERM and exited 0: no receipt, and no later step or service runs.
    signal?.throwIfAborted();
    if (interrupted !== undefined) {
      throw new Error(`setup ${name}: interrupted by ${interrupted} while running "${step.run}"; the step is not recorded as done`);
    }
    if (code !== 0) throw new Error(`setup ${name}: command "${step.run}" failed (exit code ${code})`);
    if (identity !== undefined) {
      done.set(identity, receiptFor(step, identity));
      await persist();
    }
  }
  if (ran === 0) process.stdout.write(`[portler] setup ${name}: nothing to run\n`);
}
