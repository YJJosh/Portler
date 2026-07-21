import fs from 'node:fs/promises';
import path from 'node:path';
import { loadBaseEnv } from '../config/index.ts';
import { buildGeneratedEnv, buildServiceEnv } from '../env/index.ts';
import { formatYamlDocuments } from '../parse/yaml-format.ts';
import { portlerDir } from '../state/index.ts';
import { containerEnvEntries, k8sServiceNames, namespaceManifest, serviceManifests } from './manifests.ts';
import type { Assignments, PortlerConfig } from '../types/index.ts';

/** The `.portler/k8s/` directory holding the generated manifests. */
export function k8sManifestDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'k8s');
}

/** Sorts first so `kubectl apply -f dir` creates the namespace before namespaced resources. */
export const NAMESPACE_MANIFEST_FILE = '00-namespace.yml';

export interface RenderedManifests {
  /** One YAML file per resource group; the namespace file sorts first so `kubectl apply -f dir` creates it before namespaced resources. */
  files: Array<{ fileName: string; text: string }>;
  /** Portler service name -> sanitized Kubernetes resource name. */
  names: Map<string, string>;
}

/**
 * Render the Kubernetes YAML for the selected services (a k8s-mode config)
 * using the given port assignments for env/reference resolution.
 */
export async function renderManifests(
  config: PortlerConfig,
  selectedNames: string[],
  assignments: Assignments,
): Promise<RenderedManifests> {
  const names = k8sServiceNames(selectedNames);
  const generatedEnv = buildGeneratedEnv(assignments);
  const baseEnv = await loadBaseEnv(config);

  const files: RenderedManifests['files'] = [
    { fileName: NAMESPACE_MANIFEST_FILE, text: formatYamlDocuments([namespaceManifest(config)]) },
  ];

  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    const name = names.get(serviceName)!;
    const { env, explicitKeys } = buildServiceEnv(config, service, baseEnv, generatedEnv, assignments);
    const manifests = serviceManifests(config, service, name, containerEnvEntries(env, explicitKeys));
    files.push({ fileName: `${name}.yml`, text: formatYamlDocuments(manifests) });
  }

  return { files, names };
}

/** Replace `.portler/k8s/` with the rendered files; returns the directory. */
export async function writeManifestFiles(projectDir: string, rendered: RenderedManifests): Promise<string> {
  const dir = k8sManifestDir(projectDir);

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  for (const file of rendered.files) {
    await fs.writeFile(path.join(dir, file.fileName), file.text, 'utf8');
  }

  return dir;
}
