import net from 'node:net';
import { loadBaseEnv, loadConfig, resolveServiceCwd } from '../../config/index.ts';
import { applyProduction } from '../../config/production.ts';
import { buildGeneratedEnv, resolveEnvValue } from '../../env/index.ts';
import { runShell } from '../../process/shell.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';

async function freePort(host: string): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export function selectStartService(config: PortlerConfig, requested: string[]): ServiceConfig {
  if (requested.length > 1) throw new Error('start accepts exactly one service name');
  const candidates = Object.values(config.services).filter((service) => service.command && !service.docker);
  const name = requested[0];
  const service = name ? config.services[name] : candidates.length === 1 ? candidates[0] : undefined;
  if (!service) {
    throw new Error(`${name ? `unknown service "${name}"` : 'start requires a service name'}. Candidates: ${candidates.map((entry) => entry.name).join(', ') || '(none)'}`);
  }
  if (service.docker) throw new Error(`start is for local processes; service "${service.name}" runs in Docker. Use "portler up" instead.`);
  if (!service.command) throw new Error(`service "${service.name}" has no command`);
  return service;
}

/** No registry or runtime state: deployment references use declared endpoints. */
export async function buildStartEnv(
  config: PortlerConfig,
  service: ServiceConfig,
  baseEnv: EnvMap,
  platformEnv: NodeJS.ProcessEnv = process.env,
): Promise<EnvMap> {
  const platformPort = platformEnv.PORT;
  if (platformPort !== undefined && (!/^\d+$/.test(platformPort) || Number(platformPort) < 1 || Number(platformPort) > 65535)) {
    throw new Error(`PORT must be a port between 1 and 65535, got "${platformPort}"`);
  }
  const port = platformPort !== undefined ? Number(platformPort) : service.port ?? await freePort(service.host);
  const assignments: Assignments = {};
  for (const entry of Object.values(config.services)) {
    const assignedPort = entry.name === service.name ? port : entry.port;
    if (assignedPort === undefined) continue;
    const host = entry.urlHost.includes(':') ? `[${entry.urlHost}]` : entry.urlHost;
    assignments[entry.name] = {
      name: entry.name, port: assignedPort, desiredPort: entry.port,
      host: entry.host, urlHost: entry.urlHost, protocol: entry.protocol,
      url: `${entry.protocol}://${host}:${assignedPort}`,
      containerName: entry.docker?.containerName, image: entry.docker?.image,
    };
  }
  // The deployment wins over portler.yml: the platform env (applied below), then the use_env
  // file, then config. Only config values are Portler expressions; a file value is used as
  // written, exactly as `up` and `setup` treat it, and a config key the file or the platform
  // supplies is not resolved at all.
  const configured = { ...config.env, ...service.env };
  const env: EnvMap = {};
  for (const [key, value] of Object.entries(configured)) {
    // Own-property checks: `toString` or `constructor` are valid variable names, and a
    // plain `in` or index lookup would find the inherited Object.prototype member instead.
    if ((Object.hasOwn(platformEnv, key) && platformEnv[key] !== undefined) || Object.hasOwn(baseEnv, key)) continue;
    try {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid env key');
      env[key] = resolveEnvValue(value, assignments);
    } catch (error) {
      const source = Object.hasOwn(service.env, key) ? `services.${service.name}.env` : 'env';
      throw new Error(`${source}.${key}: ${(error as Error).message}`);
    }
  }
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!Object.hasOwn(platformEnv, key) || platformEnv[key] === undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(platformEnv)) {
    if (value !== undefined) env[key] = value;
  }
  // Portler's own values go on top of the platform's: generated PORTLER_* values,
  // PORTLER_SERVICE_NAME and the port_env names are derived from the chosen port (which the
  // platform's PORT selected above), so a stale PORTLER_* value in the shell cannot replace them.
  Object.assign(env, buildGeneratedEnv(assignments), { PORTLER_SERVICE_NAME: service.name });
  for (const key of service.portEnv) env[key] = String(port);
  return env;
}

export async function commandStart(args: ParsedArgs): Promise<number> {
  const config = applyProduction(await loadConfig(process.cwd(), args.file), args.prod);
  const service = selectStartService(config, args.positionals);
  const env = await buildStartEnv(config, service, await loadBaseEnv(config, { allowMissing: true }));
  return runShell(service.command!, resolveServiceCwd(config, service), env);
}
