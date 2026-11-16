import { mergeEnvMaps, normalizeEnvSpecs } from './env-spec.ts';
import { isObject, optionalNumber, optionalString } from './scalars.ts';
import type { K8sConfig, K8sVolumeConfig, PortlerConfig, ServiceConfig, UnknownMap } from '../types/index.ts';

function normalizeK8sVolume(rawVolume: unknown, pathPrefix: string): K8sVolumeConfig | undefined {
  if (rawVolume === undefined || rawVolume === null) return undefined;

  if (typeof rawVolume === 'string') {
    return { size: rawVolume };
  }

  if (!isObject(rawVolume)) throw new Error(`${pathPrefix}.volume must be a string size or an object`);

  const size = optionalString(rawVolume.size, `${pathPrefix}.volume.size`);
  if (!size) throw new Error(`${pathPrefix}.volume.size is required (e.g. 1Gi)`);

  return {
    size,
    mountPath:
      optionalString(rawVolume.mount_path, `${pathPrefix}.volume.mount_path`) ??
      optionalString(rawVolume.mountPath, `${pathPrefix}.volume.mountPath`),
  };
}

/** The service's `k8s:` key, used only by `up k8s`; undefined when absent. */
export function normalizeK8sConfig(rawService: UnknownMap, serviceName: string): K8sConfig | undefined {
  const rawK8s = rawService.k8s;
  if (rawK8s === undefined || rawK8s === null) return undefined;

  const pathPrefix = `services.${serviceName}.k8s`;

  if (rawK8s === true) {
    return { replicas: 1, env: {} };
  }

  if (!isObject(rawK8s)) throw new Error(`${pathPrefix} must be true or an object`);

  const replicas = optionalNumber(rawK8s.replicas, `${pathPrefix}.replicas`) ?? 1;
  // `up k8s` waits for a stable pod and port-forwards to it, which replicas: 0 never gives.
  if (replicas < 1) throw new Error(`${pathPrefix}.replicas must be at least 1`);

  const env = rawK8s.env ?? rawK8s.environment ?? {};
  if (!isObject(env)) throw new Error(`${pathPrefix}.env/environment must be an object`);

  return {
    replicas,
    env: normalizeEnvSpecs(env, `${pathPrefix}.env`),
    volume: normalizeK8sVolume(rawK8s.volume, pathPrefix),
  };
}

/** The config for `up k8s` and `k8s render`: container config as in Docker mode, with `k8s.env` on top. */
export function applyK8sMode(config: PortlerConfig): PortlerConfig {
  const services: Record<string, ServiceConfig> = {};

  for (const [serviceName, service] of Object.entries(config.services)) {
    const docker = service.dockerModeOverride ?? service.docker;
    const k8s: K8sConfig = service.k8s ?? { replicas: 1, env: {} };

    services[serviceName] = {
      ...service,
      docker,
      k8s,
      env: mergeEnvMaps(mergeEnvMaps(service.env, docker?.env), k8s.env),
      // A `command` healthcheck usually shells into a Docker container, which k8s mode does
      // not have; the default TCP check goes through the port-forward.
      healthcheck: service.healthcheck?.type === 'command' ? undefined : service.healthcheck,
    };
  }

  return {
    ...config,
    runMode: 'k8s',
    services,
  };
}
