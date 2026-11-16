import path from 'node:path';
import { managedVolumeName, normalizeVolumeToken, volumeFullName, volumeLabelArgs, volumeScope } from '../config/index.ts';
import { buildGeneratedEnv, exportEnvReader, PORTLER_INTERNAL_ENV_KEYS, resolveEnvValue, serviceViewer } from '../env/index.ts';
import { serviceTransport, transportProtocols } from '../ports/transport.ts';
import { dockerLabelArgs, PROJECT_LABEL } from './ownership.ts';
import type { Assignments, DockerConfig, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Only keys Portler composed (env files, root/service env, generated PORTLER_*, port_env)
// get `-e`: the inherited host env (PATH, HOME, ...) would break the container.
function dockerEnvEntries(env: EnvMap, explicitEnvKeys: ReadonlySet<string>): [string, string][] {
  const entries: [string, string][] = [];

  for (const [key, value] of Object.entries(env)) {
    // Defaults that keep local child processes non-interactive; a container owns
    // its own package-manager policy.
    if (PORTLER_INTERNAL_ENV_KEYS.has(key)) continue;

    // The PORTLER_ prefix alone never forwards a key: host controls (PORTLER_HOME, Kubernetes
    // safety overrides, ...) and host secrets belong to the Portler process, not the container.
    if (explicitEnvKeys.has(key)) entries.push([key, value]);
  }

  return entries.sort(([left], [right]) => left.localeCompare(right));
}

function normalizeVolume(config: PortlerConfig, volume: string): string {
  const parts = volume.split(':');
  if (parts.length < 2) return volume;

  const source = parts[0]!;
  if (source.startsWith('.')) {
    parts[0] = path.resolve(config.projectDir, source);
  } else if (source.startsWith('@')) {
    const volumeName = source.slice(1);
    if (!volumeName) throw new Error(`invalid Docker volume "${volume}": @ shorthand requires a name`);
    parts[0] = volumeFullName(volumeScope(config).prefix, volumeName, config.volumeSet);
  }

  return parts.join(':');
}

// Pre-creates `@name` volumes with portler.* labels so `portler volumes` finds them:
// `docker run -v` would create them unlabelled.
function ensureVolumeCommands(config: PortlerConfig, docker: DockerConfig): string[] {
  const commands: string[] = [];
  const template = shellQuote(`{{if .Labels}}{{index .Labels "${PROJECT_LABEL}"}}{{end}}`);
  const expectedOwner = shellQuote(volumeScope(config).owner);

  for (const volumeEntry of docker.volumes) {
    const rawName = managedVolumeName(volumeEntry);
    if (rawName === undefined) continue;
    const name = normalizeVolumeToken(rawName, `volume name in "${volumeEntry}"`);
    const fullNameValue = volumeFullName(volumeScope(config).prefix, name, config.volumeSet);
    const fullName = shellQuote(fullNameValue);
    const labels = volumeLabelArgs(volumeScope(config).owner, name, config.volumeSet).map(shellQuote).join(' ');
    const foreignMessage = shellQuote(
      `[portler] error: Docker volume "${fullNameValue}" exists but is not managed by this project; refusing to mount it`,
    );

    // `docker volume create <existing>` exits zero, so a create can lose a race to
    // a foreign creator unnoticed. Re-inspect and check the label before mounting.
    commands.push(
      `if ! volume_owner=$(docker volume inspect --format ${template} ${fullName} 2>/dev/null); then ` +
        `docker volume create ${labels} ${fullName} >/dev/null || exit 1; ` +
        `volume_owner=$(docker volume inspect --format ${template} ${fullName}) || exit 1; fi; ` +
        `if [ "$volume_owner" != ${expectedOwner} ]; then printf '%s\\n' ${foreignMessage} >&2; exit 1; fi`,
    );
  }

  return commands;
}

function dockerBuildCommand(config: PortlerConfig, service: ServiceConfig, assignments: Assignments, baseEnv: EnvMap): string | undefined {
  const docker = service.docker;
  const build = docker?.build;
  if (!docker || !build) return undefined;

  const args = ['docker', 'build', '-t', docker.image];

  if (build.dockerfile) {
    const dockerfilePath = path.isAbsolute(build.dockerfile)
      ? build.dockerfile
      : path.resolve(config.projectDir, build.context, build.dockerfile);
    args.push('-f', dockerfilePath);
  }
  if (build.target) args.push('--target', build.target);

  // Build args resolve as the image runs (`${db.address}` is the project-network alias). Exports
  // read the exporter's effective env, not the config alone (no shell, .env or mode overrides).
  const resolveOptions = { config, viewer: serviceViewer(config, service), self: service.name,
    exportEnv: exportEnvReader(config, baseEnv, buildGeneratedEnv(assignments), assignments) };
  for (const [key, value] of Object.entries(build.args)) {
    args.push('--build-arg', `${key}=${resolveEnvValue(value, assignments, resolveOptions)}`);
  }

  args.push(path.resolve(config.projectDir, build.context));

  return args.map(shellQuote).join(' ');
}

function dockerRunCommand(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
): string {
  const docker = service.docker;
  if (!docker) throw new Error(`service "${service.name}" is not a Docker service`);

  const args = [
    'docker',
    'run',
    '--rm',
    '--name',
    docker.containerName,
    ...dockerLabelArgs(config.projectDir, service.name),
    '--network',
    config.dockerNetwork,
    '--network-alias',
    service.name,
    // Docker on Linux has no host.docker.internal unless added (Docker Desktop defines it).
    ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
  ];

  if (assignment && service.port !== undefined) {
    for (const protocol of transportProtocols(serviceTransport(service))) {
      // Docker publishes TCP when no protocol is given; keep that spelling for TCP.
      args.push('-p', `${assignment.host}:${assignment.port}:${service.port}${protocol === 'udp' ? '/udp' : ''}`);
    }
  }

  for (const [key, value] of dockerEnvEntries(env, explicitEnvKeys)) {
    args.push('-e', `${key}=${value}`);
  }

  for (const volume of docker.volumes) {
    args.push('-v', normalizeVolume(config, volume));
  }

  args.push(docker.image);

  if (docker.command) {
    args.push('sh', '-lc', docker.command);
  }

  return args.map(shellQuote).join(' ');
}

// "<id> <owner label>" from one inspect, so the removed ID is the one whose label was
// checked: a name can be re-pointed between two commands, an ID cannot.
function containerIdentityTemplate(): string {
  return `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${PROJECT_LABEL}"}}{{end}}`;
}

// Network labels sit at the top level, not under .Config.
function networkOwnerTemplate(): string {
  return `{{if .Labels}}{{index .Labels "${PROJECT_LABEL}"}}{{end}}`;
}

// Splits containerIdentityTemplate's output; owner may be empty.
const SPLIT_IDENTITY = 'cid=${info%% *}; owner=${info#* }';

// Removes a leftover container of our name by ID, only if labelled ours; a foreign one aborts
// the start. `-v` drops its anonymous volumes, as `--rm` would.
function preflightRemoveContainer(config: PortlerConfig, containerName: string): string {
  const name = shellQuote(containerName);
  const project = shellQuote(config.projectDir);
  const template = shellQuote(containerIdentityTemplate());

  return (
    `if info=$(docker inspect --type container --format ${template} ${name} 2>/dev/null); then ` +
    `${SPLIT_IDENTITY}; ` +
    `if [ "$owner" != ${project} ]; then ` +
    `printf '%s\\n' ${shellQuote(
      `[portler] error: container "${containerName}" exists but is not managed by this project; refusing to remove it. ` +
        'Rename it, remove it yourself, or set container_name.',
    )} >&2; ` +
    'exit 1; fi; ' +
    'docker rm -f -v "$cid" >/dev/null 2>&1 || true; fi'
  );
}

// Exit trap: removes our own container by ID, never a foreign one.
function trapRemoveContainer(config: PortlerConfig, containerName: string): string {
  const name = shellQuote(containerName);
  const project = shellQuote(config.projectDir);
  const template = shellQuote(containerIdentityTemplate());

  return (
    `if info=$(docker inspect --type container --format ${template} ${name} 2>/dev/null); then ` +
    `${SPLIT_IDENTITY}; ` +
    `if [ "$owner" = ${project} ]; then docker rm -f -v "$cid" >/dev/null 2>&1 || true; fi; fi`
  );
}

// A foreign network aborts the start. Re-inspect after a create: a parallel `docker network
// create` may have won the race; a failing final inspect exits with docker's error.
function ensureNetwork(config: PortlerConfig): string {
  const network = shellQuote(config.dockerNetwork);
  const project = shellQuote(config.projectDir);
  const template = shellQuote(networkOwnerTemplate());
  const labels = dockerLabelArgs(config.projectDir).map(shellQuote).join(' ');

  return (
    `if ! net_owner=$(docker network inspect --format ${template} ${network} 2>/dev/null); then ` +
    `docker network create ${labels} ${network} >/dev/null 2>&1 || true; ` +
    `net_owner=$(docker network inspect --format ${template} ${network}) || exit 1; ` +
    'fi; ' +
    `if [ "$net_owner" != ${project} ]; then ` +
    `printf '%s\\n' ${shellQuote(
      `[portler] error: Docker network "${config.dockerNetwork}" exists but is not managed by this project; ` +
        'refusing to use it. Set docker_network in portler.yml, or remove it.',
    )} >&2; ` +
    'exit 1; fi'
  );
}

/** Build (if set), owned network and volumes, stale-container removal, then the run with a cleanup trap. */
export function dockerShellCommand(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
  baseEnv: EnvMap = {},
): string {
  const docker = service.docker;
  if (!docker) throw new Error(`service "${service.name}" is not a Docker service`);

  const build = dockerBuildCommand(config, service, assignments, baseEnv);
  const run = dockerRunCommand(config, service, env, explicitEnvKeys, assignment);
  const commands = [
    build,
    ensureNetwork(config),
    ...ensureVolumeCommands(config, docker),
    preflightRemoveContainer(config, docker.containerName),
    `trap ${shellQuote(trapRemoveContainer(config, docker.containerName))} EXIT INT TERM`,
    run,
  ].filter((command): command is string => Boolean(command));

  return commands.join(' && ');
}
