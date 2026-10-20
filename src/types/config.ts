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
  /** http only: the response statuses that mean ready. Default: any 2xx or 3xx. */
  accept?: number[];
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
  /** `container_name:` was set in the config; `name` does not rename it. */
  containerNameExplicit?: true;
  volumes: string[];
  env: UnknownMap;
  command?: string;
  /**
   * The container runs the service's `command` (a service with top-level
   * `image`/`build`), so `prod.command` reaches it. Absent for a `docker:`
   * block, which sets its own command or leaves the image CMD, even when the
   * text it sets happens to match `command`.
   */
  commandFromService?: true;
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

/**
 * One setup command. A plain string in portler.yml is the same as `{ run }`:
 * it runs once per checkout and again when its command or cwd changes (the
 * receipt lives in `.portler/setup.json`). `if_missing` runs it only while
 * nothing exists at that path, relative to the step's cwd; `always` runs it on
 * every `up` and `setup`. Neither of those two keeps a receipt.
 */
export interface SetupStep {
  run: string;
  ifMissing?: string;
  always?: boolean;
  /** Plain steps only: files whose content is part of the receipt, relative to the step's cwd. */
  watch?: string[];
}

export interface ProductionConfig {
  setup?: SetupStep[];
  command?: string;
  env: UnknownMap;
  /** Keys the deployment must supply under --prod; checked before anything runs, forwarded to containers. */
  require: string[];
  /** Top-level only: the services that run under --prod. The rest are external to the deployment. */
  services?: string[];
}

export interface ServiceConfig {
  setup?: SetupStep[];
  prod?: ProductionConfig;
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
  /** Independent bind address; defaults to the root host. */
  host?: string;
  /** Exact IP addresses of edges allowed to supply forwarding metadata. */
  trustedProxies: string[];
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
  setup?: SetupStep[];
  prod?: ProductionConfig;
  /**
   * Stable project name (`name:` in portler.yml). Under --prod it names the
   * Docker network, the containers and the managed volumes in place of the
   * directory hash, so a release that unpacks into a new folder keeps its
   * volumes, and a release that starts while the previous one is still up is
   * refused by Docker on the container name. Development runs ignore it.
   */
  name?: string;
  /** `docker_network:` was set in the config; `name` does not rename it. */
  dockerNetworkExplicit?: true;
  /** Set by applyProduction: the deployment (process env, then use_env files) wins over config env. */
  production?: boolean;
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
