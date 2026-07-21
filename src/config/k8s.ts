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

/**
 * Normalize the service's `k8s:` key, which configures how the service runs
 * under `portler up k8s` only. Returns undefined when the key is absent —
 * plain `up` and `up docker` never consult it.
 */
export function normalizeK8sConfig(rawService: UnknownMap, serviceName: string): K8sConfig | undefined {
  const rawK8s = rawService.k8s;
  if (rawK8s === undefined || rawK8s === null) return undefined;

  const pathPrefix = `services.${serviceName}.k8s`;

  if (rawK8s === true) {
    return { replicas: 1, env: {} };
  }

  if (!isObject(rawK8s)) throw new Error(`${pathPrefix} must be true or an object`);

  const replicas = optionalNumber(rawK8s.replicas, `${pathPrefix}.replicas`) ?? 1;
  // `up k8s` waits for at least one stable pod and establishes a port-forward.
  // replicas: 0 can never satisfy that lifecycle and previously hung until the
  // 120-second stability timeout.
  if (replicas < 1) throw new Error(`${pathPrefix}.replicas must be at least 1`);

  const env = rawK8s.env ?? rawK8s.environment ?? {};
  if (!isObject(env)) throw new Error(`${pathPrefix}.env/environment must be an object`);

  return {
    replicas,
    env,
    volume: normalizeK8sVolume(rawK8s.volume, pathPrefix),
  };
}

/**
 * Rewrite the config for `portler up k8s` / `portler k8s render`: every
 * service resolves its container config exactly like Docker mode (the
 * `docker:` override winning over the always-Docker config), then layers the
 * `k8s.env` overrides on top so in-cluster values (Kubernetes DNS service
 * names) win over Docker-network and host-facing ones.
 */
export function applyK8sMode(config: PortlerConfig): PortlerConfig {
  const services: Record<string, ServiceConfig> = {};

  for (const [serviceName, service] of Object.entries(config.services)) {
    const docker = service.dockerModeOverride ?? service.docker;
    const k8s: K8sConfig = service.k8s ?? { replicas: 1, env: {} };

    services[serviceName] = {
      ...service,
      docker,
      k8s,
      env: { ...service.env, ...(docker?.env ?? {}), ...k8s.env },
      // `command` healthchecks usually shell into Docker containers that do
      // not exist in k8s mode; fall back to the default TCP check through the
      // port-forward instead.
      healthcheck: service.healthcheck?.type === 'command' ? undefined : service.healthcheck,
    };
  }

  return {
    ...config,
    services,
  };
}
