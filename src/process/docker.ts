import path from 'node:path';
import { managedVolumeName, normalizeVolumeToken, projectVolumeName, volumeLabelArgs } from '../config/index.ts';
import { PORTLER_INTERNAL_ENV_KEYS, resolveEnvValue } from '../env/index.ts';
import { dockerLabelArgs, PROJECT_LABEL } from './ownership.ts';
import type { Assignments, DockerConfig, EnvMap, PortlerConfig, ServiceAssignment, ServiceConfig } from '../types/index.ts';

function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Select which env vars get -e flags. The full composed env must NOT be
 * forwarded — it contains the whole inherited host env (PATH, HOME, ...),
 * which would break the container — so only the keys Portler itself composed
 * (env files, root/service env, generated PORTLER_* values, port_env) are
 * passed through, minus Portler's host-process-only internal defaults.
 */
function dockerEnvEntries(env: EnvMap, explicitEnvKeys: ReadonlySet<string>): [string, string][] {
  const entries: [string, string][] = [];

  for (const [key, value] of Object.entries(env)) {
    // Host-process defaults exist only to make Portler's local child processes
    // non-interactive. A container owns its own package-manager policy, even if
    // one of these keys was added to the composed-key set internally.
    if (PORTLER_INTERNAL_ENV_KEYS.has(key)) continue;

    // Generated PORTLER_* values and project-declared env are already explicit.
    // The prefix alone must not authorize forwarding: inherited host controls
    // (PORTLER_GLOBAL_DIR, PORTLER_HOME, Kubernetes safety overrides) and any
    // arbitrary host PORTLER_* secrets belong to the Portler process, not the
    // service container.
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
    parts[0] = projectVolumeName(config.volumeRoot, volumeName, config.volumeSet);
  }

  return parts.join(':');
}

/**
 * Commands that pre-create the service's Portler-managed `@name` volumes with
 * portler.* labels so `portler volumes` can find them later. `docker run -v`
 * would create them implicitly, but without labels; the leading inspect keeps
 * the create idempotent for volumes that already exist (labeled or not).
 */
function ensureVolumeCommands(config: PortlerConfig, docker: DockerConfig): string[] {
  const commands: string[] = [];
  const template = shellQuote(`{{if .Labels}}{{index .Labels "${PROJECT_LABEL}"}}{{end}}`);
  const expectedOwner = shellQuote(config.volumeRoot);

  for (const volumeEntry of docker.volumes) {
    const rawName = managedVolumeName(volumeEntry);
    if (rawName === undefined) continue;
    const name = normalizeVolumeToken(rawName, `volume name in "${volumeEntry}"`);
    const fullNameValue = projectVolumeName(config.volumeRoot, name, config.volumeSet);
    const fullName = shellQuote(fullNameValue);
    const labels = volumeLabelArgs(config.volumeRoot, name, config.volumeSet).map(shellQuote).join(' ');
    const foreignMessage = shellQuote(
      `[portler] error: Docker volume "${fullNameValue}" exists but is not managed by this project; refusing to mount it`,
    );

    // `docker volume create <existing>` is idempotent, so an absent-check followed
    // by create can lose a race to a foreign creator and still exit zero. Always
    // re-inspect and verify the project label before docker run gets a chance to
    // mount (and modify) the volume.
    commands.push(
      `if ! volume_owner=$(docker volume inspect --format ${template} ${fullName} 2>/dev/null); then ` +
        `docker volume create ${labels} ${fullName} >/dev/null || exit 1; ` +
        `volume_owner=$(docker volume inspect --format ${template} ${fullName}) || exit 1; fi; ` +
        `if [ "$volume_owner" != ${expectedOwner} ]; then printf '%s\\n' ${foreignMessage} >&2; exit 1; fi`,
    );
  }

  return commands;
}

function dockerBuildCommand(config: PortlerConfig, service: ServiceConfig, assignments: Assignments): string | undefined {
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

  for (const [key, value] of Object.entries(build.args)) {
    args.push('--build-arg', `${key}=${resolveEnvValue(value, assignments)}`);
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
  ];

  if (assignment && service.port !== undefined) {
    args.push('-p', `${assignment.host}:${assignment.port}:${service.port}`);
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

/**
 * Go template printing a container's immutable ID and its owning-project label
 * (empty when unlabelled), separated by a space. Both come from ONE inspect, so
 * the ID we remove and the label we authorized it on cannot drift apart: the
 * NAME can be re-pointed at a different container between the two commands, the
 * ID cannot.
 */
function containerIdentityTemplate(): string {
  return `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${PROJECT_LABEL}"}}{{end}}`;
}

/** Same idea for a network (labels sit at the top level there). */
function networkOwnerTemplate(): string {
  return `{{if .Labels}}{{index .Labels "${PROJECT_LABEL}"}}{{end}}`;
}

/** Split "<id> <owner>" from the template above; owner may be empty. */
const SPLIT_IDENTITY = 'cid=${info%% *}; owner=${info#* }';

/**
 * Remove a leftover container with our name, but ONLY if it is labelled as
 * ours, and then BY ID. `docker rm -f <name>` on a name collision would destroy
 * an unrelated container (and its data), so a foreign owner aborts the start.
 */
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
    'docker rm -f "$cid" >/dev/null 2>&1 || true; fi'
  );
}

/** Exit-trap cleanup: remove our own container by ID, never a foreign one. */
function trapRemoveContainer(config: PortlerConfig, containerName: string): string {
  const name = shellQuote(containerName);
  const project = shellQuote(config.projectDir);
  const template = shellQuote(containerIdentityTemplate());

  return (
    `if info=$(docker inspect --type container --format ${template} ${name} 2>/dev/null); then ` +
    `${SPLIT_IDENTITY}; ` +
    `if [ "$owner" = ${project} ]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi; fi`
  );
}

/**
 * Ensure the project network exists AND belongs to this project.
 *
 * Three distinct situations, all of which used to end in "the network exists,
 * carry on":
 * - it exists and is ours            -> use it
 * - it exists and is NOT ours        -> refuse to start (we would attach the
 *   service to a stranger's network, and a later `down` would try to remove it)
 * - it does not exist                -> create it, then re-inspect, because a
 *   parallel `docker network create` may have won the race — and the winner
 *   might not be another Portler service of this project.
 *
 * A failing final inspect (daemon down, no permission) exits non-zero with
 * docker's own error on stderr instead of silently continuing.
 */
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

/**
 * Build the shell command that (optionally builds, then) ensures the network,
 * cleans up any stale container of ours, and runs the service container with
 * cleanup traps wired to EXIT/INT/TERM.
 */
export function dockerShellCommand(
  config: PortlerConfig,
  service: ServiceConfig,
  env: EnvMap,
  explicitEnvKeys: ReadonlySet<string>,
  assignment: ServiceAssignment | undefined,
  assignments: Assignments,
): string {
  const docker = service.docker;
  if (!docker) throw new Error(`service "${service.name}" is not a Docker service`);

  const build = dockerBuildCommand(config, service, assignments);
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
