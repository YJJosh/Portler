import type { PortTransport } from './config.ts';

export interface ServiceAssignment {
  name: string;
  port: number;
  desiredPort?: number;
  host: string;
  urlHost: string;
  protocol: string;
  url: string;
  /** Set only for a port that is not plain TCP. */
  transport?: PortTransport;
  containerName?: string;
  image?: string;
}

export type Assignments = Record<string, ServiceAssignment>;

export interface StateFile {
  version: 1;
  project: string;
  updatedAt: string;
  services: Record<string, ServiceAssignment>;
}

export interface PidServiceInfo {
  pid: number;
  command: string;
  cwd: string;
  port?: number;
  url?: string;
  dockerContainer?: string;
  dockerNetwork?: string;
  /** Started with `--prod` (absent: development). `restart` keeps the mode and refuses the other. */
  prod?: boolean;
  /** Replayed by `restart` unless given one; when absent, inferred from the container. */
  runMode?: 'local' | 'docker' | 'k8s';
  /** The `--image` pin the service was started with; `restart` replays it unless given a new one. */
  image?: string;
  /** `false` when the service was started with `--no-setup`; `restart` replays that unless given `--setup`. */
  setup?: boolean;
  /**
   * Set of the container's `@` volumes, replayed by `restart` unless given one. Only for a container
   * mounting a managed volume; absent on such an entry with runMode means the base volumes.
   */
  volumeSet?: string;
  /** Opaque OS start time of `pid`, re-read before signalling to prove it was not recycled. Absent before 0.2.0. */
  startToken?: string;
  /**
   * The `depends_on` the starting run read, so an edited portler.yml cannot stop a dependency a
   * newer run needs. Absent before 0.2.2.
   */
  dependsOn?: string[];
  startedAt: string;
}

export interface PidsFile {
  version: 1;
  project: string;
  startedAt: string;
  services: Record<string, PidServiceInfo>;
}

export interface RegistryEntry {
  project: string;
  service: string;
  port: number;
  desiredPort?: number;
  /** Host the reservation was probed/bound on; absent in pre-0.2 files. */
  host?: string;
  /** Transports the reservation was probed on; absent means TCP. */
  transport?: PortTransport;
  assignedAt: string;
}

export interface RegistryFile {
  version: 1;
  ports: Record<string, RegistryEntry>;
}
