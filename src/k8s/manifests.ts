import { k8sName } from '../config/index.ts';
import { PORTLER_INTERNAL_ENV_KEYS } from '../env/index.ts';
import { projectHash } from '../util/hash.ts';
import type { EnvMap, PortlerConfig, ServiceConfig, UnknownMap } from '../types/index.ts';

/** One Kubernetes resource as a plain object ready for YAML serialization. */
export type K8sManifest = UnknownMap;

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const PROJECT_LABEL = 'portler.dev/project';

/**
 * Labels stamped on every generated resource so `portler down k8s` (and curious
 * users) can find everything belonging to this project.
 *
 * These labels are not decoration: the project label is what makes a namespace
 * (and the Deployments in it) deletable by this project and untouchable by any
 * other, and it is the whole selector a delete runs on. It therefore uses the
 * collision-resistant projectHash, not the short cosmetic name hash — two
 * project paths that collided here would be able to delete each other's
 * workloads.
 */
export function projectLabels(config: PortlerConfig): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: 'portler',
    [PROJECT_LABEL]: projectHash(config.projectDir),
  };
}

/**
 * Map each selected service to its sanitized Kubernetes resource name,
 * erroring when two services collapse onto the same name.
 */
export function k8sServiceNames(serviceNames: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const seen = new Map<string, string>();

  for (const serviceName of serviceNames) {
    const name = k8sName(serviceName);
    const existing = seen.get(name);
    if (existing) {
      throw new Error(`services "${existing}" and "${serviceName}" both map to Kubernetes name "${name}"; rename one`);
    }
    seen.set(name, serviceName);
    names.set(serviceName, name);
  }

  return names;
}

/**
 * Select which composed env vars go into the container spec. Mirrors Docker
 * mode: only keys Portler itself composed (env files, root/service/k8s env,
 * generated PORTLER_* values, port_env) are forwarded — never the whole
 * inherited host environment, and never Portler's host-process-internal
 * defaults (e.g. pnpm_config_verify_deps_before_run).
 */
export function containerEnvEntries(env: EnvMap, explicitEnvKeys: ReadonlySet<string>): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];

  for (const [key, value] of Object.entries(env)) {
    if (PORTLER_INTERNAL_ENV_KEYS.has(key)) continue;

    // Generated PORTLER_* values and project-declared env are already explicit.
    // Never infer intent from the prefix: inherited host controls, paths,
    // safety overrides, and arbitrary PORTLER_* secrets must not be serialized
    // into a Deployment manifest.
    if (explicitEnvKeys.has(key)) entries.push({ name: key, value });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Container mount path for the k8s volume: explicit `mount_path`, else the
 * container path of the service's first Docker volume, else /data.
 */
function volumeMountPath(service: ServiceConfig): string {
  const explicit = service.k8s?.volume?.mountPath;
  if (explicit) return explicit;

  for (const volume of service.docker?.volumes ?? []) {
    const parts = volume.split(':');
    if (parts.length >= 2 && parts[1]!.startsWith('/')) return parts[1]!;
  }

  return '/data';
}

function namespacedMetadata(config: PortlerConfig, name: string, appName: string): UnknownMap {
  return {
    name,
    namespace: config.k8sNamespace,
    labels: { ...projectLabels(config), app: appName },
  };
}

export function namespaceManifest(config: PortlerConfig): K8sManifest {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
      name: config.k8sNamespace,
      labels: projectLabels(config),
    },
  };
}

function pvcManifest(config: PortlerConfig, service: ServiceConfig, name: string): K8sManifest {
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: namespacedMetadata(config, `${name}-data`, name),
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: {
        requests: { storage: service.k8s!.volume!.size },
      },
    },
  };
}

function deploymentManifest(
  config: PortlerConfig,
  service: ServiceConfig,
  name: string,
  env: Array<{ name: string; value: string }>,
): K8sManifest {
  const docker = service.docker;
  if (!docker) throw new Error(`service "${service.name}" has no container config for Kubernetes`);

  const volume = service.k8s?.volume;
  const container: UnknownMap = {
    name,
    image: docker.image,
    // Locally built images are loaded straight into the cluster (kind load /
    // minikube image load / shared Docker Desktop daemon), so the kubelet
    // must not try to pull them from a registry.
    imagePullPolicy: 'IfNotPresent',
  };

  if (docker.command) container.command = ['sh', '-lc', docker.command];
  if (service.port !== undefined) container.ports = [{ containerPort: service.port }];
  if (env.length > 0) container.env = env;
  if (volume) container.volumeMounts = [{ name: 'data', mountPath: volumeMountPath(service) }];

  const podSpec: UnknownMap = { containers: [container] };
  if (volume) {
    podSpec.volumes = [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }];
  }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: namespacedMetadata(config, name, name),
    spec: {
      replicas: service.k8s?.replicas ?? 1,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels: { ...projectLabels(config), app: name } },
        spec: podSpec,
      },
    },
  };
}

function serviceManifest(config: PortlerConfig, service: ServiceConfig, name: string): K8sManifest {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: namespacedMetadata(config, name, name),
    spec: {
      selector: { app: name },
      // Expose the declared port so in-cluster DNS URLs like
      // postgres://…@postgres:5432 work exactly like Docker network aliases.
      ports: [{ port: service.port, targetPort: service.port }],
    },
  };
}

/**
 * All manifests for one service: PVC (when `k8s.volume` is set), Deployment,
 * and Service (when the service declares a port).
 */
export function serviceManifests(
  config: PortlerConfig,
  service: ServiceConfig,
  name: string,
  env: Array<{ name: string; value: string }>,
): K8sManifest[] {
  const manifests: K8sManifest[] = [];

  if (service.k8s?.volume) manifests.push(pvcManifest(config, service, name));
  manifests.push(deploymentManifest(config, service, name, env));
  if (service.port !== undefined) manifests.push(serviceManifest(config, service, name));

  return manifests;
}
