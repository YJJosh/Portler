import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_PORT_RANGE } from '../constants.ts';
import { parseDotEnv } from '../parse/dotenv.ts';
import { parseYaml } from '../parse/yaml.ts';
import { pathExists } from '../util/fs.ts';
import { didYouMean } from '../util/suggest.ts';
import { findDependencyCycle, normalizeDependsOn } from './dependencies.ts';
import { normalizeDockerModeConfig, normalizeTopLevelDockerConfig } from './docker.ts';
import { normalizeHealthcheck } from './healthcheck.ts';
import { normalizeK8sConfig } from './k8s.ts';
import { defaultDockerNetwork, defaultK8sNamespace, k8sName } from './naming.ts';
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
import type { EnvMap, PortlerConfig, PortRange, ServiceConfig, UnknownMap } from '../types/index.ts';

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

  const config: PortlerConfig = {
    filePath,
    projectDir,
    useEnv: normalizeEnvFiles(root.use_env ?? root.env_file),
    env: normalizeEnvObject(root.env, 'env'),
    host,
    urlHost,
    protocol,
    portRange: normalizePortRange(root),
    preferDeclaredPort,
    dockerNetwork: optionalString(root.docker_network, 'docker_network') ?? defaultDockerNetwork(projectDir),
    volumeRoot: await resolveVolumeRoot(projectDir),
    volumeSet: normalizeVolumeSet(options.volumeSet ?? process.env.PORTLER_VOLUME_SET),
    volumes: [],
    k8sNamespace: normalizeK8sNamespace(root, projectDir),
    // A null prototype is defense in depth for library callers that construct a
    // PortlerConfig manually. Loaded service names are validated below too.
    services: Object.create(null) as Record<string, ServiceConfig>,
  };

  const serviceByEnvPrefix = new Map<string, string>();

  for (const [serviceName, rawService] of Object.entries(servicesRoot)) {
    validateServiceName(serviceName);
    const envPrefix = generatedEnvPrefix(serviceName);
    const collidingService = serviceByEnvPrefix.get(envPrefix);
    if (collidingService) {
      throw new Error(
        `service names "${collidingService}" and "${serviceName}" both generate PORTLER_${envPrefix}_* environment variables; rename one`,
      );
    }
    serviceByEnvPrefix.set(envPrefix, serviceName);

    if (!isObject(rawService)) throw new Error(`services.${serviceName} must be an object`);
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
    const command = optionalString(rawService.command, `services.${serviceName}.command`);
    const cwd = optionalString(rawService.cwd, `services.${serviceName}.cwd`) ?? '.';
    const serviceEnv = normalizeEnvObject(rawService.env ?? rawService.environment, `services.${serviceName}.env/environment`);

    const topLevelDocker = normalizeTopLevelDockerConfig(rawService, serviceName, projectDir);
    const dockerModeOverride = normalizeDockerModeConfig(rawService, serviceName, projectDir, topLevelDocker);

    const service: ServiceConfig = {
      name: serviceName,
      command,
      cwd,
      port,
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

  config.proxy = normalizeProxyConfig(root, config.services);

  config.volumes = collectDeclaredVolumes(config.services);

  return config;
}

export async function loadBaseEnv(config: PortlerConfig): Promise<EnvMap> {
  const env: EnvMap = {};

  for (const envFile of config.useEnv) {
    const filePath = path.resolve(config.projectDir, envFile);

    if (!(await pathExists(filePath))) {
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
