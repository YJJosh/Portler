import { loadConfig } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { buildGeneratedEnv, buildPrintableEnv } from '../../env/index.ts';
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
    return { assignments: state.services, generatedEnv: buildGeneratedEnv(state.services) };
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
  const config = await loadConfig(process.cwd(), args.file);
  if (args.positionals.length > 1) throw new Error('env accepts at most one service name');

  const serviceName = args.positionals[0];
  const service: ServiceConfig | null = serviceName ? config.services[serviceName] ?? null : null;
  if (serviceName && !service) throw new Error(`unknown service "${serviceName}"`);

  return withLifecycleLock(config.projectDir, async () => {
    const { assignments, generatedEnv } = await ensureAssignments(config);
    // Always refresh runtime.env, even when cached state was reused, so a
    // manually deleted file comes back.
    await writeRuntimeEnv(config.projectDir, generatedEnv);

    process.stdout.write(formatDotEnv(buildPrintableEnv(config, service, generatedEnv, assignments)));
    return 0;
  });
}
