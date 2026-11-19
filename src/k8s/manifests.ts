import { k8sName } from '../config/index.ts';
import { PORTLER_INTERNAL_ENV_KEYS } from '../env/index.ts';
import { serviceTransport, transportProtocols } from '../ports/transport.ts';
import { projectHash } from '../util/hash.ts';
import type { EnvMap, PortlerConfig, ServiceConfig, UnknownMap } from '../types/index.ts';

/** One Kubernetes resource as a plain object ready for YAML serialization. */
export type K8sManifest = UnknownMap;

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const PROJECT_LABEL = 'portler.dev/project';

/**
 * Labels on every generated resource. The project label decides what this project may delete, so it uses the
 * collision-resistant projectHash, not the short name hash: colliding projects could delete each other's workloads.
 */
export function projectLabels(config: PortlerConfig): Record<string, string> {
  return {
    [MANAGED_BY_LABEL]: 'portler',
    [PROJECT_LABEL]: projectHash(config.projectDir),
  };
}

/** Throws when two services map to the same Kubernetes name. */
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

/** As in Docker mode, only keys Portler composed are forwarded, never the inherited host env or PORTLER_INTERNAL_ENV_KEYS. */
export function containerEnvEntries(env: EnvMap, explicitEnvKeys: ReadonlySet<string>): Array<{ name: string; value: string }> {
  const entries: Array<{ name: string; value: string }> = [];

  for (const [key, value] of Object.entries(env)) {
    if (PORTLER_INTERNAL_ENV_KEYS.has(key)) continue;

    // Not by PORTLER_ prefix: inherited PORTLER_* controls and secrets must not reach a manifest.
    if (explicitEnvKeys.has(key)) entries.push({ name: key, value });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

// `mount_path`, else the container path of the first Docker volume, else /data.
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
    // Local images are loaded into the cluster, so the kubelet must not pull them from a registry.
    imagePullPolicy: 'IfNotPresent',
  };

  if (docker.command) container.command = ['sh', '-lc', docker.command];
  if (service.port !== undefined) {
    const protocols = transportProtocols(serviceTransport(service));
    // TCP is Kubernetes' default, so a TCP-only port needs no name or protocol.
    container.ports = protocols.map((protocol) =>
      protocol === 'tcp' && protocols.length === 1
        ? { containerPort: service.port }
        : { name: protocol, containerPort: service.port, protocol: protocol.toUpperCase() },
    );
  }
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

// One port per protocol; Kubernetes requires a name on each when there are several.
function servicePorts(service: ServiceConfig): UnknownMap[] {
  const protocols = transportProtocols(serviceTransport(service));
  if (protocols.length === 1 && protocols[0] === 'tcp') return [{ port: service.port, targetPort: service.port }];
  return protocols.map((protocol) => ({ name: protocol, port: service.port, targetPort: service.port, protocol: protocol.toUpperCase() }));
}

function serviceManifest(config: PortlerConfig, service: ServiceConfig, name: string): K8sManifest {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: namespacedMetadata(config, name, name),
    spec: {
      selector: { app: name },
      // The declared port, so in-cluster DNS (postgres:5432) works like a Docker network alias.
      ports: servicePorts(service),
    },
  };
}

/** A PVC when `k8s.volume` is set, the Deployment, and a Service when it has a port. */
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
