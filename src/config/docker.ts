import { applyK8sMode } from './k8s.ts';
import { defaultDockerContainer, defaultDockerImage } from './naming.ts';
import { isObject, normalizeEnvObject, normalizeStringArray, optionalString } from './scalars.ts';
import type { DockerBuildConfig, DockerConfig, PortlerConfig, ServiceConfig, UnknownMap } from '../types/index.ts';

export type RunMode = 'local' | 'docker' | 'k8s';

function normalizeDockerBuild(
  rawBuild: unknown,
  rawService: UnknownMap,
  serviceName: string,
  pathPrefix = `services.${serviceName}`,
): DockerBuildConfig | undefined {
  const topLevelDockerfile = optionalString(rawService.dockerfile, `${pathPrefix}.dockerfile`);

  if (rawBuild === undefined || rawBuild === null) {
    if (!topLevelDockerfile) return undefined;
    return {
      context: '.',
      dockerfile: topLevelDockerfile,
      args: {},
    };
  }

  if (typeof rawBuild === 'string') {
    return {
      context: rawBuild,
      dockerfile: topLevelDockerfile,
      args: {},
    };
  }

  if (!isObject(rawBuild)) throw new Error(`${pathPrefix}.build must be a string or object`);

  const args = normalizeEnvObject(rawBuild.args, `${pathPrefix}.build.args`);

  return {
    context: optionalString(rawBuild.context, `${pathPrefix}.build.context`) ?? '.',
    dockerfile: topLevelDockerfile ?? optionalString(rawBuild.dockerfile, `${pathPrefix}.build.dockerfile`),
    target: optionalString(rawBuild.target, `${pathPrefix}.build.target`),
    args,
  };
}

function readDockerEnv(raw: UnknownMap, pathPrefix: string): UnknownMap {
  return normalizeEnvObject(raw.env ?? raw.environment, `${pathPrefix}.env/environment`);
}

function normalizeDockerConfigFromObject(
  rawDocker: UnknownMap,
  serviceName: string,
  projectDir: string,
  pathPrefix: string,
  fallbackImage?: string,
): DockerConfig {
  const rawImage = optionalString(rawDocker.image, `${pathPrefix}.image`);
  const build = normalizeDockerBuild(rawDocker.build, rawDocker, serviceName, pathPrefix);
  const volumes = normalizeStringArray(rawDocker.volumes, `${pathPrefix}.volumes`);
  const containerName =
    optionalString(rawDocker.container_name, `${pathPrefix}.container_name`) ??
    optionalString(rawDocker.containerName, `${pathPrefix}.containerName`) ??
    defaultDockerContainer(projectDir, serviceName);

  return {
    image: rawImage ?? fallbackImage ?? defaultDockerImage(projectDir, serviceName),
    build,
    containerName,
    volumes,
    env: readDockerEnv(rawDocker, pathPrefix),
    command: optionalString(rawDocker.command, `${pathPrefix}.command`),
  };
}

export function normalizeTopLevelDockerConfig(
  rawService: UnknownMap,
  serviceName: string,
  projectDir: string,
): DockerConfig | undefined {
  const rawImage = optionalString(rawService.image, `services.${serviceName}.image`);
  const build = normalizeDockerBuild(rawService.build, rawService, serviceName);
  const explicitType = optionalString(rawService.type, `services.${serviceName}.type`);
  const volumes = normalizeStringArray(rawService.volumes, `services.${serviceName}.volumes`);
  const hasTopLevelDocker = Boolean(rawImage || build || volumes.length > 0 || explicitType === 'docker');

  if (!hasTopLevelDocker) return undefined;
  if (explicitType && explicitType !== 'docker') throw new Error(`services.${serviceName}.type only supports "docker" right now`);

  return normalizeDockerConfigFromObject(
    rawService,
    serviceName,
    projectDir,
    `services.${serviceName}`,
    rawImage ?? defaultDockerImage(projectDir, serviceName),
  );
}

/**
 * Normalize the service's `docker:` key, which configures how the service
 * runs under `portler up docker` only. Returns undefined when the key is
 * absent — plain `up` never consults it, and applyDockerMode falls back to
 * the always-Docker config from normalizeTopLevelDockerConfig.
 */
export function normalizeDockerModeConfig(
  rawService: UnknownMap,
  serviceName: string,
  projectDir: string,
  topLevelDocker: DockerConfig | undefined,
): DockerConfig | undefined {
  const rawDocker = rawService.docker;
  if (rawDocker === undefined || rawDocker === null) return undefined;

  if (rawDocker === true) {
    return topLevelDocker ?? {
      image: defaultDockerImage(projectDir, serviceName),
      containerName: defaultDockerContainer(projectDir, serviceName),
      volumes: [],
      env: {},
    };
  }

  if (typeof rawDocker === 'string') {
    return {
      image: rawDocker,
      containerName: defaultDockerContainer(projectDir, serviceName),
      volumes: [],
      env: {},
    };
  }

  if (!isObject(rawDocker)) throw new Error(`services.${serviceName}.docker must be true, a string image, or an object`);

  return normalizeDockerConfigFromObject(rawDocker, serviceName, projectDir, `services.${serviceName}.docker`, topLevelDocker?.image);
}

/**
 * Rewrite the config for `portler up docker`: every service that has any
 * Docker configuration runs in Docker (its `docker:` override winning over
 * the always-Docker config), with the Docker env merged into the service env
 * so downstream layering treats those keys as service-explicit.
 */
export function applyDockerMode(config: PortlerConfig): PortlerConfig {
  const services: Record<string, ServiceConfig> = {};

  for (const [serviceName, service] of Object.entries(config.services)) {
    const docker: DockerConfig | undefined = service.dockerModeOverride ?? service.docker;
    services[serviceName] = docker
      ? {
          ...service,
          docker,
          env: { ...service.env, ...docker.env },
        }
      : {
          ...service,
          docker: undefined,
        };
  }

  return {
    ...config,
    services,
  };
}

export function configForRunMode(config: PortlerConfig, mode: RunMode): PortlerConfig {
  if (mode === 'docker') return applyDockerMode(config);
  if (mode === 'k8s') return applyK8sMode(config);
  return config;
}
