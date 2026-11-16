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
  /**
   * Started with `--prod`. `restart` keeps the mode: a plain restart refuses a
   * production service, `restart --prod` a development one. Absent counts as
   * development.
   */
  prod?: boolean;
  /**
   * The run mode of the starting command, replayed by `restart` unless given
   * one. When absent, `restart` infers it from the container.
   */
  runMode?: 'local' | 'docker' | 'k8s';
  /** The `--image` pin the service was started with; `restart` replays it unless given a new one. */
  image?: string;
  /** `false` when the service was started with `--no-setup`; `restart` replays that unless given `--setup`. */
  setup?: boolean;
  /**
   * The volume set the container's `@` volumes were mounted from; `restart`
   * replays it unless given one. Recorded only for a container mounting a managed
   * volume; absent on such an entry with runMode, it means the base volumes.
   */
  volumeSet?: string;
  /**
   * Opaque OS start-time token for `pid`, captured at spawn and re-read before
   * signalling to prove the pid was not recycled. Absent in files from
   * Portler < 0.2.0.
   */
  startToken?: string;
  /**
   * The `depends_on` the starting run read. A foreground `up` tearing down after
   * a `restart` uses the replacements' list, so an edited portler.yml cannot stop
   * a dependency the newer run needs. Absent in files from Portler < 0.2.2.
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
