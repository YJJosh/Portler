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
   * Whether the service was started with `--prod`. `restart` keeps this mode: a
   * plain restart refuses a production service and `restart --prod` refuses a
   * development one. Entries without the field predate it (a Portler without a
   * production mode wrote them) and count as development.
   */
  prod?: boolean;
  /**
   * The run mode of the command that started the service (`up docker` or
   * plain `up`), replayed by `restart` unless it is given a mode. Entries
   * without it predate the field; `restart` then infers it from the container.
   */
  runMode?: 'local' | 'docker' | 'k8s';
  /** The `--image` pin the service was started with; `restart` replays it unless given a new one. */
  image?: string;
  /** `false` when the service was started with `--no-setup`; `restart` replays that unless given `--setup`. */
  setup?: boolean;
  /**
   * The volume set (`--volume-set` or PORTLER_VOLUME_SET) a container's
   * Portler-managed `@` volumes were mounted from; `restart` replays it unless
   * given one. Recorded only for a container that mounts a managed volume; such
   * an entry with runMode and without this field mounted the base volumes.
   */
  volumeSet?: string;
  /**
   * Opaque OS start-time token for `pid`, captured at spawn. A pid can be
   * recycled onto an unrelated process; re-reading this token before signalling
   * proves the pid still refers to the process Portler started. Absent in PID
   * files written by Portler < 0.2.0.
   */
  startToken?: string;
  /**
   * Names of the services this one was started depending on (its `depends_on`
   * as the run that started it read them). A foreground `up` tearing down after
   * a `restart` replaced some of its services keeps whatever the replacements
   * recorded here, so an edited `portler.yml` cannot make it stop a dependency
   * the newer run still needs. Absent in PID files written by Portler < 0.2.2.
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
