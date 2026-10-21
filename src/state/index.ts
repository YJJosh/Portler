import fs from 'node:fs/promises';
import path from 'node:path';
import { formatDotEnv } from '../parse/dotenv.ts';
import { isObject, isOptionalPort, isOptionalString, isPort, isString } from '../util/guards.ts';
import { readValidatedJsonFile, writeJsonFile } from '../util/json-file.ts';
import type { Assignments, EnvMap, ServiceAssignment, StateFile } from '../types/index.ts';

function isServiceAssignment(value: unknown): value is ServiceAssignment {
  return (
    isObject(value) &&
    isString(value.name) &&
    isPort(value.port) &&
    isOptionalPort(value.desiredPort) &&
    isString(value.host) &&
    isString(value.urlHost) &&
    isString(value.protocol) &&
    isString(value.url) &&
    isOptionalString(value.containerName) &&
    isOptionalString(value.image)
  );
}

function isAssignments(value: unknown): value is Assignments {
  return isObject(value) && Object.values(value).every(isServiceAssignment);
}

function isStateFile(value: unknown): value is StateFile {
  return (
    isObject(value) &&
    value.version === 1 &&
    isString(value.project) &&
    isString(value.updatedAt) &&
    isAssignments(value.services)
  );
}

/** The per-project `.portler/` directory holding runtime state. */
export function portlerDir(projectDir: string): string {
  return path.join(projectDir, '.portler');
}

export function statePath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'state.json');
}

export function runtimeEnvPath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'runtime.env');
}

export function k8sContextPath(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'k8s-context.json');
}

interface K8sContextFile {
  version: 1;
  project: string;
  context: string;
  savedAt: string;
}

function isK8sContextFile(value: unknown): value is K8sContextFile {
  return (
    isObject(value) &&
    value.version === 1 &&
    isString(value.project) &&
    isString(value.context) &&
    value.context !== '' &&
    isString(value.savedAt)
  );
}

export async function readState(projectDir: string): Promise<StateFile | null> {
  // A copied checkout may carry the source project's `.portler/` directory.
  // Never reuse that project's assignments under a different identity.
  return readValidatedJsonFile(
    statePath(projectDir),
    'Portler state file',
    (value): value is StateFile => isStateFile(value) && value.project === projectDir,
  );
}

export async function writeState(projectDir: string, assignments: Assignments): Promise<void> {
  const state: StateFile = {
    version: 1,
    project: projectDir,
    updatedAt: new Date().toISOString(),
    services: assignments,
  };

  await writeJsonFile(statePath(projectDir), state);
}

export async function writeRuntimeEnv(projectDir: string, env: EnvMap): Promise<void> {
  await fs.mkdir(portlerDir(projectDir), { recursive: true });
  await fs.writeFile(runtimeEnvPath(projectDir), formatDotEnv(env), 'utf8');
}

/**
 * The kubectl context the last `up k8s` deployed to, so `env` and `down k8s` ask that
 * cluster instead of whichever context is active when they run. Null when nothing is saved.
 */
export async function readK8sContext(projectDir: string): Promise<string | null> {
  const saved = await readValidatedJsonFile(
    k8sContextPath(projectDir),
    'Portler Kubernetes context file',
    (value): value is K8sContextFile => isK8sContextFile(value) && value.project === projectDir,
  );
  return saved?.context ?? null;
}

export async function writeK8sContext(projectDir: string, context: string): Promise<void> {
  const saved: K8sContextFile = { version: 1, project: projectDir, context, savedAt: new Date().toISOString() };
  await writeJsonFile(k8sContextPath(projectDir), saved);
}

export async function clearK8sContext(projectDir: string): Promise<void> {
  await fs.rm(k8sContextPath(projectDir), { force: true });
}
