export interface ServiceAssignment {
  name: string;
  port: number;
  desiredPort?: number;
  host: string;
  urlHost: string;
  protocol: string;
  url: string;
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
  assignedAt: string;
}

export interface RegistryFile {
  version: 1;
  ports: Record<string, RegistryEntry>;
}
