import path from 'node:path';
import { resolveEnvValue } from '../env/index.ts';
import { runStreaming } from './exec.ts';
import type { Assignments, PortlerConfig, ServiceConfig } from '../types/index.ts';

function dockerBuildArgs(config: PortlerConfig, service: ServiceConfig, assignments: Assignments): string[] | undefined {
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

  for (const [key, value] of Object.entries(build.args)) {
    args.push('--build-arg', `${key}=${resolveEnvValue(value, assignments)}`);
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
export async function buildServiceImages(config: PortlerConfig, selectedNames: string[], assignments: Assignments): Promise<string[]> {
  const builtImages: string[] = [];

  for (const serviceName of selectedNames) {
    const service = config.services[serviceName]!;
    const args = dockerBuildArgs(config, service, assignments);
    if (!args) continue;

    process.stdout.write(`[portler] building image ${service.docker!.image} for ${serviceName}...\n`);
    await runStreaming('docker', args, serviceName, config.projectDir);
    builtImages.push(service.docker!.image);
  }

  return builtImages;
}
