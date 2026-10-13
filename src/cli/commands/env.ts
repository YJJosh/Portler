import { applyProduction, productionServices } from '../../config/production.ts';
import { loadBaseEnv, loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertRequiredEnv, blankRequiredKeys, buildEffectiveEnv, buildGeneratedEnv, buildPrintableEnv, deploymentEnv, maskSecrets, requiredEnvKeys } from '../../env/index.ts';
import { formatDotEnv } from '../../parse/dotenv.ts';
import { allocateAssignments } from '../../ports/index.ts';
import { readPids, runningServices } from '../../process/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { Assignments, EnvMap, PortlerConfig, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { servicesWithPorts } from '../services.ts';

/**
 * Return the current port assignments plus their generated env, allocating
 * (and persisting) them as a deliberate side effect when state is missing,
 * incomplete, or has stale Docker metadata.
 */
export async function ensureAssignments(config: PortlerConfig): Promise<{ assignments: Assignments; generatedEnv: EnvMap }> {
  const state = await readState(config.projectDir);
  const configuredWithPorts = servicesWithPorts(config, Object.keys(config.services));
  if (config.proxy) configuredWithPorts.push(PROXY_SERVICE_NAME);

  const hasAll = configuredWithPorts.every((serviceName) => state?.services?.[serviceName]);
  const hasFreshDockerMetadata = Object.values(config.services).every((service) => {
    if (!service.docker || service.port === undefined) return true;
    return state?.services?.[service.name]?.containerName === service.docker.containerName;
  });
  if (state && hasAll && hasFreshDockerMetadata) {
    // state.json can hold more than this config runs: a development run's assignments seen
    // through --prod (services prod.services leaves out), or a service since removed. Return
    // what a fresh allocation would, one assignment per configured service, so `env --prod`
    // prints no values for an external service and `setup --prod` cannot resolve `${db.url}`
    // where `up --prod` rejects it. state.json itself is left as it is.
    const configured = new Set(configuredWithPorts);
    const assignments: Assignments = Object.assign(Object.create(null) as Assignments, Object.fromEntries(Object.entries(state.services).filter(([name]) => configured.has(name))));
    return { assignments, generatedEnv: buildGeneratedEnv(assignments) };
  }

  // Never re-reserve currently-running services: allocateAssignments would
  // re-probe their busy ports and move them away from where they listen.
  const running = new Set(runningServices(await readPids(config.projectDir)));
  const reserveServices = configuredWithPorts.filter((serviceName) => !running.has(serviceName));

  const assignments = await allocateAssignments(config, state, reserveServices, running);
  await writeState(config.projectDir, assignments);
  return { assignments, generatedEnv: buildGeneratedEnv(assignments) };
}

export async function commandEnv(args: ParsedArgs): Promise<number> {
  if (args.reveal && !args.prod) {
    throw new Error('--reveal applies to "env --prod": the development view prints config values, not the deployment\'s secrets');
  }
  if (args.positionals.length > 1) throw new Error('env accepts at most one service name');
  const config = applyProduction(productionServices(await loadConfig(process.cwd(), args.file), args.prod, args.positionals), args.prod);

  const serviceName = args.positionals[0];
  const service: ServiceConfig | null = serviceName ? config.services[serviceName] ?? null : null;
  if (serviceName && !service) throw new Error(`unknown service "${serviceName}"`);

  return withLifecycleLock(config.projectDir, async () => {
    const { assignments, generatedEnv } = await ensureAssignments(config);
    // Always refresh runtime.env, even when cached state was reused, so a
    // manually deleted file comes back.
    await writeRuntimeEnv(config.projectDir, generatedEnv);

    if (!args.prod) {
      process.stdout.write(formatDotEnv(buildPrintableEnv(config, service, generatedEnv, assignments)));
      return 0;
    }
    // The deployment view: what `up --prod` hands the service, with the deployment's values
    // (process env, then the use_env file, then config) and only the keys it forwards.
    const baseEnv = await loadBaseEnv(config, { allowMissing: true });
    const effective = buildEffectiveEnv(config, service, baseEnv, generatedEnv, assignments);
    try {
      assertRequiredEnv(
        service ? `service ${service.name}` : 'the project',
        service ? requiredEnvKeys(config, service) : requiredEnvKeys(config),
        deploymentEnv(baseEnv),
        blankRequiredKeys(config, service ?? undefined),
      );
    } catch (error) {
      process.stderr.write(`[portler] ${(error as Error).message}\n`);
    }
    process.stdout.write(formatDotEnv(maskSecrets(effective, args.reveal)));
    return 0;
  });
}
