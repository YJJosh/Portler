import path from 'node:path';
import { loadBaseEnv } from '../config/index.ts';
import { buildGeneratedEnv, exportEnvReader, resolveEnvValue, serviceViewer } from '../env/index.ts';
import { runStreaming } from './exec.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig } from '../types/index.ts';

function dockerBuildArgs(config: PortlerConfig, service: ServiceConfig, assignments: Assignments, baseEnv: EnvMap): string[] | undefined {
  const docker = service.docker;
  const build = docker?.build;
  if (!docker || !build) return undefined;

  const args = ['build', '-t', docker.image];

  if (build.dockerfile) {
    const dockerfilePath = path.isAbsolute(build.dockerfile)
      ? build.dockerfile
      : path.resolve(config.projectDir, build.context, build.dockerfile);
    args.push('-f', dockerfilePath);
  }
  if (build.target) args.push('--target', build.target);

  // Build args resolve as the image will run: in the cluster.
  // REVIEW: Use the same effective export env as runtime env resolution.
  const resolveOptions = { config, viewer: serviceViewer(config, service), self: service.name,
    exportEnv: exportEnvReader(config, baseEnv, buildGeneratedEnv(assignments), assignments) };
  for (const [key, value] of Object.entries(build.args)) {
    args.push('--build-arg', `${key}=${resolveEnvValue(value, assignments, resolveOptions)}`);
  }

  args.push(path.resolve(config.projectDir, build.context));

  return args;
}

/**
 * Build the Docker image for every selected service with a `build` config.
 * Returns the image names that were built locally — exactly the ones that
 * must be loaded into the cluster (registry images are pulled by the cluster
 * itself).
 */
export async function buildServiceImages(
  config: PortlerConfig,
  selectedNames: string[],
  assignments: Assignments,
  signal?: AbortSignal,
): Promise<string[]> {
  const builtImages: string[] = [];
  const baseEnv = selectedNames.some((name) => config.services[name]?.docker?.build) ? await loadBaseEnv(config) : {};

  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    const args = dockerBuildArgs(config, service, assignments, baseEnv);
    if (!args) continue;

    process.stdout.write(`[portler] building image ${service.docker!.image} for ${serviceName}...\n`);
    await runStreaming('docker', args, serviceName, config.projectDir, signal);
    builtImages.push(service.docker!.image);
  }

  return builtImages;
}
