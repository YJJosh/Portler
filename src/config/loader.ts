import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PORT_RANGE } from '../constants.ts';
import { parseDotEnv } from '../parse/dotenv.ts';
import { parseYaml } from '../parse/yaml.ts';
import { isPortTransport, PORT_TRANSPORTS, usesTcp } from '../ports/transport.ts';
import { pathExists } from '../util/fs.ts';
import { didYouMean } from '../util/suggest.ts';
import { REFERENCE_PROPERTIES } from '../env/resolve.ts';
import { findDependencyCycle, normalizeDependsOn } from './dependencies.ts';
import { normalizeEnvSpecs } from './env-spec.ts';
import { applyServicePreset } from './presets.ts';
import { normalizeDockerModeConfig, normalizeTopLevelDockerConfig } from './docker.ts';
import { normalizeHealthcheck } from './healthcheck.ts';
import { normalizeK8sConfig } from './k8s.ts';
import { defaultDockerNetwork, defaultK8sNamespace, k8sName, VOLUME_SET_SEPARATOR } from './naming.ts';
import { normalizeProduction, normalizeSetup } from './production.ts';
import { normalizeProxyConfig } from './proxy.ts';
import { collectDeclaredVolumes, normalizeVolumeSet, resolveVolumeRoot } from './volumes.ts';
import {
  isObject,
  normalizeEnvFiles,
  normalizeEnvObject,
  normalizePortEnv,
  optionalBoolean,
  optionalPort,
  optionalString,
} from './scalars.ts';
import type { EnvMap, PortlerConfig, PortRange, PortTransport, ServiceConfig, TaskConfig, UnknownMap } from '../types/index.ts';

function normalizePortRange(root: UnknownMap): PortRange {
  const rawRange = root.port_range;
  if (rawRange !== undefined && rawRange !== null && !isObject(rawRange)) {
    throw new Error('port_range must be an object with start and end');
  }

  // Each bound is validated as a port in its own right, so `port_start: 0` is
  // rejected by name whether it came from port_range or the top-level keys —
  // the old code only range-checked when a `port_range:` object was present.
  const startFromRoot = optionalPort(root.port_start, 'port_start');
  const endFromRoot = optionalPort(root.port_end, 'port_end');
  const range = isObject(rawRange) ? rawRange : {};

  const start = optionalPort(range.start, 'port_range.start') ?? startFromRoot ?? DEFAULT_PORT_RANGE.start;
  const end = optionalPort(range.end, 'port_range.end') ?? endFromRoot ?? DEFAULT_PORT_RANGE.end;

  if (start > end) {
    throw new Error(`invalid port range ${start}-${end}: start must not be greater than end`);
  }

  return { start, end };
}

function normalizeK8sNamespace(root: UnknownMap, projectDir: string): string {
  const explicit = optionalString(root.k8s_namespace, 'k8s_namespace');
  if (explicit === undefined) return defaultK8sNamespace(projectDir);
  if (explicit !== k8sName(explicit)) {
    throw new Error(`k8s_namespace "${explicit}" is not a valid Kubernetes name (lowercase alphanumerics and dashes)`);
  }
  return explicit;
}

const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function generatedEnvPrefix(serviceName: string): string {
  // Keep this exactly aligned with env/generate.ts's upperSnake(): trailing
  // punctuation is stripped there, so `api` and `api-` collide just as surely
  // as `api-main` and `api_main` do.
  return serviceName
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * Service names cross several boundaries: CLI arguments, service references,
 * Docker DNS aliases, generated env keys, and `.portler/logs/<name>.log`.
 * Keep them to one portable, path-safe grammar instead of letting a mapping key
 * such as `../../target` escape the log directory or `__proto__` mutate a plain
 * JavaScript record.
 */
function validateServiceName(serviceName: string): void {
  if (!SERVICE_NAME.test(serviceName)) {
    throw new Error(
      `invalid service name "${serviceName}": use 1-63 ASCII letters, digits, "_" or "-", starting with a letter or digit`,
    );
  }
}

function validateHealthcheckShape(service: ServiceConfig): void {
  const healthcheck = service.healthcheck;
  if (!healthcheck || healthcheck.type === 'none') return;

  if (healthcheck.type === 'command' && !healthcheck.command) {
    throw new Error(`services.${service.name}.healthcheck.command is required when type is "command"`);
  }
  if (healthcheck.type === 'tcp' && service.port === undefined) {
    throw new Error(`services.${service.name}.healthcheck type "tcp" requires services.${service.name}.port`);
  }
  if (healthcheck.type === 'http' && !healthcheck.url && service.port === undefined) {
    throw new Error(`services.${service.name}.healthcheck type "http" requires a url or services.${service.name}.port`);
  }
  // A UDP-only port accepts no TCP connections, so neither check could ever pass.
  if (!usesTcp(service) && (healthcheck.type === 'tcp' || (healthcheck.type === 'http' && !healthcheck.url))) {
    throw new Error(
      `services.${service.name}.healthcheck type "${healthcheck.type}" checks the port over TCP, but services.${service.name}.transport is "udp". ` +
        'Use a command healthcheck, an http url on another service, or "none".',
    );
  }
}

function normalizeTransport(value: unknown, serviceName: string, port: number | undefined): PortTransport | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPortTransport(value)) {
    throw new Error(`services.${serviceName}.transport must be one of: ${PORT_TRANSPORTS.join(', ')}`);
  }
  if (port === undefined) throw new Error(`services.${serviceName}.transport requires services.${serviceName}.port`);
  return value;
}

const EXPORT_NAME = /^[a-z][a-z0-9_]*$/;

/** `exports:` maps a name to a template; others read it as `${service.name}`. */
function normalizeExports(value: unknown, serviceName: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const field = `services.${serviceName}.exports`;
  if (!isObject(value)) throw new Error(`${field} must be a mapping of name: template`);
  const output = Object.create(null) as Record<string, string>;
  for (const [name, template] of Object.entries(value)) {
    if (!EXPORT_NAME.test(name)) throw new Error(`${field}.${name}: export names use lowercase letters, digits and "_", starting with a letter`);
    if (REFERENCE_PROPERTIES.has(name)) throw new Error(`${field}.${name} would hide the built-in "${name}" property; pick another name`);
    if (typeof template !== 'string' && typeof template !== 'number') throw new Error(`${field}.${name} must be a string template`);
    output[name] = String(template);
  }
  return output;
}

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,62}$/;
const TASK_KEYS = ['run', 'service', 'description'];

/** `tasks:` maps a name to a command, or to `{ run, service, description }`, for `portler run`. */
function normalizeTasks(value: unknown, services: Record<string, ServiceConfig>): Record<string, TaskConfig> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value)) throw new Error('tasks must be a mapping of name: command');
  const output = Object.create(null) as Record<string, TaskConfig>;
  for (const [name, raw] of Object.entries(value)) {
    const field = `tasks.${name}`;
    if (!TASK_NAME.test(name)) throw new Error(`${field}: task names use letters, digits, "_", ":", "." or "-", starting with a letter or digit`);
    if (name === 'docker' || name === 'k8s') throw new Error(`${field}: "${name}" is reserved (it selects a run mode in "portler run ${name} <name>")`);
    if (services[name]) throw new Error(`${field} has the same name as a service; "portler run ${name}" must name one or the other`);
    const spec = typeof raw === 'string' ? { run: raw } : raw;
    if (!isObject(spec)) throw new Error(`${field} must be a command or a {run, service, description} mapping`);
    for (const key of Object.keys(spec)) {
      if (!TASK_KEYS.includes(key)) throw new Error(`unknown key "${field}.${key}"; allowed keys: ${TASK_KEYS.join(', ')}`);
    }
    const run = optionalString(spec.run, `${field}.run`);
    if (run === undefined || run.trim() === '') throw new Error(`${field}.run must be a shell command`);
    const service = optionalString(spec.service, `${field}.service`);
    if (service !== undefined && !services[service]) {
      throw new Error(`${field}.service names unknown service "${service}"${didYouMean(service, Object.keys(services))}`);
    }
    const description = optionalString(spec.description, `${field}.description`);
    output[name] = { run, ...(service === undefined ? {} : { service }), ...(description === undefined ? {} : { description }) };
  }
  return output;
}

export async function findConfigFile(projectDir: string, explicitFile?: string): Promise<string> {
  if (explicitFile) {
    const filePath = path.resolve(projectDir, explicitFile);
    if (!(await pathExists(filePath))) throw new Error(`config file not found: ${filePath}`);
    return filePath;
  }

  const candidates = ['portler.yml', 'portler.yaml'];
  for (const candidate of candidates) {
    const filePath = path.join(projectDir, candidate);
    if (await pathExists(filePath)) return filePath;
  }

  throw new Error('could not find portler.yml in the current directory');
}

export interface LoadConfigOptions {
  /** Volume set selecting `@name` volume variants; PORTLER_VOLUME_SET is the fallback. */
  volumeSet?: string;
}

/**
 * `name:` goes into Docker object names as-is under --prod, so it has to be a
 * name Docker accepts. It must not contain "--" or end in "-", so the "--"
 * that ends it in a container or volume name (PROJECT_NAME_BOUNDARY) is never
 * ambiguous.
 */
function normalizeProjectName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9_.-]{0,38}[a-z0-9])?$/.test(value) || value.includes(VOLUME_SET_SEPARATOR)) {
    throw new Error('name must be 1 to 40 characters of lowercase letters, digits, "_", "." or "-", start and end with a letter or digit, and must not contain "--"');
  }
  return value;
}

export async function loadConfig(projectDir: string, explicitFile?: string, options: LoadConfigOptions = {}): Promise<PortlerConfig> {
  const filePath = await findConfigFile(projectDir, explicitFile);
  const rawText = await fs.readFile(filePath, 'utf8');
  const root = parseYaml(rawText, path.basename(filePath));

  const servicesRoot = root.services;
  if (!isObject(servicesRoot)) {
    throw new Error(`${path.basename(filePath)} must contain a top-level "services:" mapping with at least one service`);
  }

  const host = optionalString(root.host, 'host') ?? '127.0.0.1';
  const urlHost = optionalString(root.url_host, 'url_host') ?? 'localhost';
  const protocol = optionalString(root.protocol, 'protocol') ?? 'http';
  const preferDeclaredPort = optionalBoolean(root.prefer_declared_port, 'prefer_declared_port', false);
  const name = normalizeProjectName(root.name);
  const dockerNetwork = optionalString(root.docker_network, 'docker_network');

  const config: PortlerConfig = {
    filePath,
    projectDir,
    setup: normalizeSetup(root.setup, 'setup'),
    prod: normalizeProduction(root.prod, 'prod', false),
    useEnv: normalizeEnvFiles(root.use_env ?? root.env_file),
    env: normalizeEnvSpecs(normalizeEnvObject(root.env, 'env'), 'env'),
    host,
    urlHost,
    protocol,
    portRange: normalizePortRange(root),
    preferDeclaredPort,
    ...(name === undefined ? {} : { name }),
    dockerNetwork: dockerNetwork ?? defaultDockerNetwork(projectDir),
    ...(dockerNetwork === undefined ? {} : { dockerNetworkExplicit: true as const }),
    volumeRoot: await resolveVolumeRoot(projectDir),
    volumeSet: normalizeVolumeSet(options.volumeSet ?? process.env.PORTLER_VOLUME_SET),
    volumes: [],
    k8sNamespace: normalizeK8sNamespace(root, projectDir),
    // A null prototype is defense in depth for library callers that construct a
    // PortlerConfig manually. Loaded service names are validated below too.
    services: Object.create(null) as Record<string, ServiceConfig>,
  };

  const serviceByEnvPrefix = new Map<string, string>();

  for (const [serviceName, writtenService] of Object.entries(servicesRoot)) {
    validateServiceName(serviceName);
    const envPrefix = generatedEnvPrefix(serviceName);
    const collidingService = serviceByEnvPrefix.get(envPrefix);
    if (collidingService) {
      throw new Error(
        `service names "${collidingService}" and "${serviceName}" both generate PORTLER_${envPrefix}_* environment variables; rename one`,
      );
    }
    serviceByEnvPrefix.set(envPrefix, serviceName);

    if (!isObject(writtenService)) throw new Error(`services.${serviceName} must be an object`);
    if (serviceName === 'self' || serviceName === 'env') {
      const meaning = serviceName === 'self' ? '${self.port} names the service itself' : '${env.KEY} reads a service\'s own env in its exports';
      throw new Error(`service name "${serviceName}" is reserved (${meaning}); rename the service`);
    }
    const rawService = await applyServicePreset(writtenService, serviceName, projectDir);
    if (serviceName === 'docker') {
      throw new Error('service name "docker" is reserved (it selects Docker run mode in "portler up docker"); rename the service');
    }
    if (serviceName === 'k8s') {
      throw new Error('service name "k8s" is reserved (it selects Kubernetes run mode in "portler up k8s"); rename the service');
    }

    const serviceHost = optionalString(rawService.host, `services.${serviceName}.host`) ?? host;
    const serviceUrlHost = optionalString(rawService.url_host, `services.${serviceName}.url_host`) ?? urlHost;
    const serviceProtocol = optionalString(rawService.protocol, `services.${serviceName}.protocol`) ?? protocol;
    const port = optionalPort(rawService.port, `services.${serviceName}.port`);
    const transport = normalizeTransport(rawService.transport, serviceName, port);
    const command = optionalString(rawService.command, `services.${serviceName}.command`);
    const cwd = optionalString(rawService.cwd, `services.${serviceName}.cwd`) ?? '.';
    const serviceEnv = normalizeEnvSpecs(
      normalizeEnvObject(rawService.env ?? rawService.environment, `services.${serviceName}.env/environment`),
      `services.${serviceName}.env`,
    );
    const exports = normalizeExports(rawService.exports, serviceName);

    const topLevelDocker = normalizeTopLevelDockerConfig(rawService, serviceName, projectDir);
    const dockerModeOverride = normalizeDockerModeConfig(rawService, serviceName, projectDir, topLevelDocker);

    const service: ServiceConfig = {
      name: serviceName,
      setup: normalizeSetup(rawService.setup, `services.${serviceName}.setup`),
      prod: normalizeProduction(rawService.prod, `services.${serviceName}.prod`, true),
      command,
      cwd,
      port,
      ...(transport === undefined ? {} : { transport }),
      portEnv: normalizePortEnv(rawService.port_env ?? rawService.portEnv),
      env: serviceEnv,
      host: serviceHost,
      urlHost: serviceUrlHost,
      protocol: serviceProtocol,
      preferDeclaredPort: optionalBoolean(
        rawService.prefer_declared_port,
        `services.${serviceName}.prefer_declared_port`,
        preferDeclaredPort,
      ),
      dependsOn: normalizeDependsOn(rawService.depends_on ?? rawService.dependsOn, serviceName),
      healthcheck: normalizeHealthcheck(rawService.healthcheck ?? rawService.ready, serviceName),
      docker: topLevelDocker,
      dockerModeOverride,
      k8s: normalizeK8sConfig(rawService, serviceName),
      ...(exports === undefined ? {} : { exports }),
    };

    validateHealthcheckShape(service);
    config.services[serviceName] = service;
  }

  const knownServices = Object.keys(config.services);

  for (const service of Object.values(config.services)) {
    for (const dependency of service.dependsOn) {
      if (!config.services[dependency.service]) {
        throw new Error(
          `service "${service.name}" depends on unknown service "${dependency.service}"` +
            `${didYouMean(dependency.service, knownServices)}. Available services: ${knownServices.join(', ')}.`,
        );
      }
    }
  }

  const cycle = findDependencyCycle(config.services);
  if (cycle) {
    throw new Error(
      `depends_on cycle detected: ${cycle.join(' -> ')}. Remove one of these depends_on entries so the services can start in order.`,
    );
  }

  if (knownServices.length === 0) throw new Error(`${path.basename(filePath)} has no services`);

  for (const name of config.prod?.services ?? []) {
    if (!config.services[name]) {
      throw new Error(`prod.services names unknown service "${name}"${didYouMean(name, knownServices)}. Available services: ${knownServices.join(', ')}.`);
    }
  }

  config.proxy = normalizeProxyConfig(root, config.services);
  const tasks = normalizeTasks(root.tasks, config.services);
  if (tasks !== undefined) config.tasks = tasks;

  config.volumes = collectDeclaredVolumes(config.services);

  return config;
}

/**
 * Production runs (`--prod`, `start`) usually deploy from a fresh checkout or
 * source archive that never contains the gitignored env files; the platform
 * injects that env instead, so missing files are skipped there.
 */
export async function loadBaseEnv(config: PortlerConfig, options: { allowMissing?: boolean; quiet?: boolean } = {}): Promise<EnvMap> {
  const env: EnvMap = {};

  for (const envFile of config.useEnv) {
    const filePath = path.resolve(config.projectDir, envFile);

    if (!(await pathExists(filePath))) {
      if (options.allowMissing) {
        if (!options.quiet) process.stderr.write(`[portler] env file "${envFile}" not found; skipping it\n`);
        continue;
      }
      throw new Error(
        `env file "${envFile}" listed in use_env was not found at ${filePath}. ` +
          `Create the file or remove it from use_env in ${path.basename(config.filePath)}.`,
      );
    }

    const text = await fs.readFile(filePath, 'utf8');
    Object.assign(env, parseDotEnv(text, envFile));
  }

  return env;
}

export function resolveServiceCwd(config: PortlerConfig, service: ServiceConfig): string {
  return path.resolve(config.projectDir, service.cwd);
}

/**
 * Throws when a service's working directory is missing or is not a directory. Spawning in a
 * missing cwd fails as `spawn /bin/sh ENOENT`, which names the shell rather than the folder.
 */
export function assertServiceCwd(config: PortlerConfig, service: ServiceConfig): void {
  const cwd = resolveServiceCwd(config, service);
  let isDirectory: boolean | undefined;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only absence means "does not exist"; a permission or I/O error is reported as itself.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new Error(
        `service "${service.name}": cwd "${service.cwd}" resolves to ${cwd}, which cannot be checked: ${(error as Error).message}`,
      );
    }
    isDirectory = undefined;
  }
  if (isDirectory) return;
  // cwd is relative to the folder Portler runs in, which --file does not change.
  const configElsewhere = path.dirname(config.filePath) !== config.projectDir;
  throw new Error(
    `service "${service.name}": cwd "${service.cwd}" resolves to ${cwd}, which ${isDirectory === false ? 'is not a directory' : 'does not exist'}. ` +
      `cwd is relative to the project root (${config.projectDir})` +
      (configElsewhere ? `, the folder Portler runs in, not to the folder of ${config.filePath}` : '') +
      '.',
  );
}
