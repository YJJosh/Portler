import type { UnknownMap } from './common.ts';

export type DependencyCondition = 'started' | 'ready';

export interface DependencyConfig {
  service: string;
  condition: DependencyCondition;
}

export type HealthcheckType = 'none' | 'tcp' | 'http' | 'command';

export interface HealthcheckConfig {
  type: HealthcheckType;
  command?: string;
  url?: string;
  timeoutMs: number;
  intervalMs: number;
}

export interface DockerBuildConfig {
  context: string;
  dockerfile?: string;
  target?: string;
  args: UnknownMap;
}

export interface DockerConfig {
  image: string;
  build?: DockerBuildConfig;
  containerName: string;
  volumes: string[];
  env: UnknownMap;
  command?: string;
}

export interface K8sVolumeConfig {
  /** PersistentVolumeClaim size, e.g. "1Gi". */
  size: string;
  /** Container mount path; defaults to the first Docker volume's container path or /data. */
  mountPath?: string;
}

export interface K8sConfig {
  replicas: number;
  /** Env overrides for in-cluster consumption (services reach each other via k8s DNS names). */
  env: UnknownMap;
  volume?: K8sVolumeConfig;
}

export interface ServiceConfig {
  name: string;
  command?: string;
  cwd: string;
  port?: number;
  portEnv: string[];
  env: UnknownMap;
  /** Always set by the loader (service value or root fallback). */
  host: string;
  /** Always set by the loader (service value or root fallback). */
  urlHost: string;
  protocol: string;
  preferDeclaredPort: boolean;
  dependsOn: DependencyConfig[];
  healthcheck?: HealthcheckConfig;
  /**
   * Set when the service always runs in Docker (top-level image/build/
   * dockerfile/volumes/type: docker keys).
   */
  docker?: DockerConfig;
  /**
   * Docker config from the service's `docker:` key, used only when running
   * `portler up docker`; plain `up` ignores it. See applyDockerMode.
   */
  dockerModeOverride?: DockerConfig;
  /**
   * Kubernetes config from the service's `k8s:` key, used only when running
   * `portler up k8s` / `portler k8s render`. See applyK8sMode.
   */
  k8s?: K8sConfig;
}

export interface PortRange {
  start: number;
  end: number;
}

export interface ProxyRoute {
  /** Normalized path prefix ('/' or '/api' — no trailing slash otherwise). */
  prefix: string;
  service: string;
}

export interface ProxyConfig {
  /** Declared port; undefined means `auto` (Portler picks a free port). */
  port?: number;
  /** Routes sorted longest-prefix-first, ready for first-match routing. */
  routes: ProxyRoute[];
  /**
   * Extra hostnames the proxy answers for, beyond the always-allowed loopback
   * names. Requests with any other Host header are refused (DNS-rebinding
   * protection).
   */
  allowedHosts: string[];
}

/** A Portler-managed named Docker volume declared with the `@name` shorthand. */
export interface DeclaredVolume {
  /** Short volume name as written in portler.yml (without the `@`). */
  name: string;
  /** Services whose Docker config mounts this volume. */
  services: string[];
}

export interface PortlerConfig {
  filePath: string;
  projectDir: string;
  useEnv: string[];
  env: UnknownMap;
  host: string;
  urlHost: string;
  protocol: string;
  portRange: PortRange;
  preferDeclaredPort: boolean;
  dockerNetwork: string;
  /**
   * Directory whose identity scopes Portler-managed volume names. The main
   * repository root when projectDir is a linked git worktree (so worktrees
   * resolve `@name` volumes to the same project volumes), projectDir otherwise.
   */
  volumeRoot: string;
  /**
   * Active volume set (from --volume-set or PORTLER_VOLUME_SET). When set,
   * `@name` volumes resolve to the `<name>--<set>` variant.
   */
  volumeSet?: string;
  /** Portler-managed volumes (`@name` sources) declared across all services. */
  volumes: DeclaredVolume[];
  k8sNamespace: string;
  services: Record<string, ServiceConfig>;
  proxy?: ProxyConfig;
}
