import { existsSync } from 'node:fs';
import path from 'node:path';
import { applyProduction, productionServices } from '../../config/production.ts';
import { applyImageOverrides, configForRunMode, loadBaseEnv, loadConfig, type RunMode } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { buildEffectiveEnv, buildGeneratedEnv, buildPrintableEnv, envRequirementProblems, maskSecrets } from '../../env/index.ts';
import { deployedK8sServices, k8sManifestDir, k8sServiceNames, launchCluster, NAMESPACE_MANIFEST_FILE } from '../../k8s/index.ts';
import { formatDotEnv } from '../../parse/dotenv.ts';
import { allocateAssignments } from '../../ports/index.ts';
import { serviceTransport } from '../../ports/transport.ts';
import { liveServiceNames, readPids, serviceLiveness } from '../../process/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { Assignments, EnvMap, PidServiceInfo, PortlerConfig, ServiceAssignment, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, recordedRunMode, selectServiceNames, servicesWithPorts, validateDockerMode } from '../services.ts';
import { k8sForwardConfig, validateK8sForwards, validateK8sMode } from './up-k8s.ts';

// The port from state.json, container fields from `config`: state.json keeps the last allocating
// mode's container and image, which the cache check misses when both modes share a container name.
function asAllocatedFor(config: PortlerConfig, name: string, assignment: ServiceAssignment): ServiceAssignment {
  const service = config.services[name];
  if (!service) return assignment;
  if (service.docker) return { ...assignment, containerName: service.docker.containerName, image: service.docker.image };
  const copy = { ...assignment };
  delete copy.containerName;
  delete copy.image;
  return copy;
}

/** Side effect: allocates and writes state.json when it is missing, incomplete, or has stale
 * Docker/transport data. */
export async function ensureAssignments(config: PortlerConfig): Promise<{ assignments: Assignments; generatedEnv: EnvMap }> {
  const state = await readState(config.projectDir);
  const configuredWithPorts = servicesWithPorts(config, Object.keys(config.services));
  if (config.proxy) configuredWithPorts.push(PROXY_SERVICE_NAME);

  const hasAll = configuredWithPorts.every((serviceName) => state?.services?.[serviceName]);
  const hasFreshDockerMetadata = Object.values(config.services).every((service) => {
    if (!service.docker || service.port === undefined) return true;
    return state?.services?.[service.name]?.containerName === service.docker.containerName;
  });
  // A cached TCP port says nothing about UDP after a transport edit, so reallocate;
  // live services keep their ports (below).
  const hasFreshTransportMetadata = Object.values(config.services).every((service) =>
    service.port === undefined || (state?.services[service.name]?.transport ?? 'tcp') === serviceTransport(service),
  );
  if (state && hasAll && hasFreshDockerMetadata && hasFreshTransportMetadata) {
    // state.json can also hold removed services or ones prod.services leaves out: `env --prod` must
    // not show them, nor `setup --prod` resolve a `${db.url}` that `up --prod` rejects.
    const configured = new Set(configuredWithPorts);
    const cached = Object.entries(state.services).filter(([name]) => configured.has(name));
    const assignments: Assignments = Object.assign(
      Object.create(null) as Assignments,
      Object.fromEntries(cached.map(([name, assignment]) => [name, asAllocatedFor(config, name, assignment)])),
    );
    return { assignments, generatedEnv: buildGeneratedEnv(assignments) };
  }

  // Never re-reserve currently-running services: allocateAssignments would
  // re-probe their busy ports and move them away from where they listen.
  const pids = await readPids(config.projectDir);
  const running = new Set(await liveServiceNames(config.projectDir, pids));
  const reserveServices = configuredWithPorts.filter((serviceName) => !running.has(serviceName));

  const assignments = await allocateAssignments(config, state, reserveServices, running, { recorded: pids?.services });
  await writeState(config.projectDir, assignments);
  return { assignments, generatedEnv: buildGeneratedEnv(assignments) };
}

// Keeps `PORTLER_<SERVICE>_IMAGE` and `${service.image}` naming the running image when state.json
// is rebuilt. Only containers running in `mode`; a stopped entry's pin only for `lastLaunch`.
async function runningImagePins(
  loadedConfig: PortlerConfig,
  modeConfig: PortlerConfig,
  mode: RunMode,
  recordedServices: Readonly<Record<string, PidServiceInfo>>,
  lastLaunch?: string,
): Promise<Record<string, string>> {
  const localConfig = configForRunMode(loadedConfig, 'local');
  const pins: Record<string, string> = {};
  for (const [name, info] of Object.entries(recordedServices)) {
    if (info.image === undefined || modeConfig.services[name]?.docker === undefined) continue;
    if (!loadedConfig.services[name] || recordedRunMode(localConfig, name, info) !== mode) continue;
    if (name !== lastLaunch && (await serviceLiveness(loadedConfig.projectDir, info)).status === 'dead') continue;
    pins[name] = info.image;
  }
  return pins;
}

function upCommand(mode: RunMode, prod: boolean): string {
  return `portler up${mode === 'local' ? '' : ` ${mode}`}${prod ? ' --prod' : ''}`;
}

// Asks the cluster `up k8s` deployed to, not the current context: `up k8s` records only port-forwards,
// so a port-less service has no entry. Only after a render; undefined when kubectl could not be asked.
async function deployedInCluster(config: PortlerConfig, serviceName: string): Promise<boolean | undefined> {
  if (!existsSync(path.join(k8sManifestDir(config.projectDir), NAMESPACE_MANIFEST_FILE))) return false;
  try {
    k8sServiceNames(Object.keys(config.services));
  } catch {
    return false;
  }
  try {
    const launch = await launchCluster(config.projectDir);
    if (launch.source === 'gone') return undefined;
    const deployed = await deployedK8sServices(launch.cluster, config);
    return deployed === undefined ? undefined : deployed.includes(serviceName);
  } catch {
    return undefined;
  }
}

function maskConfigSecrets(env: EnvMap, secrets: ReadonlyMap<string, boolean>): EnvMap {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, secrets.get(key) && value !== '' ? '***' : value]));
}

export async function commandEnv(args: ParsedArgs): Promise<number> {
  const { mode: requestedMode, requested } = parseRunMode(args.positionals);
  const modeExplicit = requested.length < args.positionals.length;
  if (requested.length > 1) throw new Error('env accepts at most one service name');
  const loadedConfig = await loadConfig(process.cwd(), args.file);

  const serviceName = requested[0];
  if (serviceName && !loadedConfig.services[serviceName]) throw new Error(`unknown service "${serviceName}"`);

  return withLifecycleLock(loadedConfig.projectDir, async () => {
    // A recorded service, live or stale, is shown in the run mode and --prod it was started
    // with. A typed mode token or --prod wins, as for restart, with a notice.
    const recordedServices = (await readPids(loadedConfig.projectDir))?.services ?? {};
    const recorded = serviceName ? recordedServices[serviceName] : undefined;
    let recordedMode = recorded && recordedRunMode(configForRunMode(loadedConfig, 'local'), serviceName!, recorded);
    let recordedProd = recorded?.prod === true;
    // Only an entry that still runs settles it. With none, or one that has stopped, the
    // cluster may run the service: a Kubernetes service without a port is never recorded.
    const recordRuns = recorded !== undefined && (await serviceLiveness(loadedConfig.projectDir, recorded)).status !== 'dead';
    if (serviceName && !recordRuns && !modeExplicit) {
      const inCluster = await deployedInCluster(loadedConfig, serviceName);
      if (inCluster) {
        recordedMode = 'k8s';
        recordedProd = false;
      }
      if (inCluster === undefined) {
        const shown = recordedMode ? `the environment of its last "${upCommand(recordedMode, recordedProd)}" launch` : 'the local environment';
        process.stderr.write(
          `[portler] could not ask the cluster whether ${serviceName} runs there; showing ${shown} ("portler env k8s ${serviceName}" shows its Kubernetes one)\n`,
        );
      }
    }
    const mode: RunMode = modeExplicit ? requestedMode : recordedMode ?? 'local';
    const prod = args.prod === true || recordedProd;
    if (mode === 'k8s' && prod) {
      throw new Error(`--prod does not apply to k8s mode${modeExplicit ? '' : `, and ${serviceName} was started with "portler up k8s"`}`);
    }
    if (recordedMode) {
      const started = upCommand(recordedMode, recordedProd);
      if (mode !== recordedMode || prod !== recordedProd) {
        process.stderr.write(`[portler] ${serviceName} was started with "${started}"; this shows what "${upCommand(mode, prod)}" would give it instead\n`);
      } else if (mode !== 'local' || prod) {
        process.stderr.write(`[portler] ${serviceName} was started with "${started}"; this shows the environment it got\n`);
      }
    }

    const modeConfig = configForRunMode(productionServices(loadedConfig, prod, requested), mode);
    // A stopped entry still shown as the last launch keeps its pin with it.
    const lastLaunch = recorded !== undefined && !recordRuns ? serviceName : undefined;
    const pins = await runningImagePins(loadedConfig, modeConfig, mode, recordedServices, lastLaunch);
    const config = applyProduction(applyImageOverrides(modeConfig, pins), prod);
    const service: ServiceConfig | null = serviceName ? config.services[serviceName] ?? null : null;
    if (serviceName && !service) throw new Error(`unknown service "${serviceName}"`);
    // A typed mode token must describe a possible launch: refuse what `up docker` or `up k8s`
    // would, for the service and its dependencies, or every service when none is named.
    if (modeExplicit && mode !== 'local') {
      const launched = expandAndOrderServices(config, selectServiceNames(config, service ? [service.name] : []));
      if (mode === 'docker') validateDockerMode(config, launched);
      else {
        validateK8sMode(config, launched);
        validateK8sForwards(config, launched);
      }
    }

    // `config` carries the running containers' pins, so the assignments name their images.
    // A k8s launch forwards only TCP to this machine, as `up k8s` allocates it.
    const { assignments, generatedEnv } = await ensureAssignments(mode === 'k8s' ? k8sForwardConfig(config) : config);
    // Also from cached state, so a deleted runtime.env comes back.
    await writeRuntimeEnv(config.projectDir, generatedEnv);

    // A missing required value is reported, not fatal: this view is how one finds out.
    const baseEnv = await loadBaseEnv(config, { allowMissing: true, quiet: !prod });
    for (const problem of envRequirementProblems(config, service ? [service.name] : [], baseEnv, { project: !service })) {
      process.stderr.write(`[portler] ${problem}\n`);
    }
    const secrets = new Map<string, boolean>();
    if (!prod) {
      // The development view prints config values, so it hides only what the config marks secret
      // (also through an export) and secret-looking values from the shell or a use_env file.
      const printable = buildPrintableEnv(config, service, generatedEnv, assignments, baseEnv, secrets);
      const marked = new Map([...secrets].filter(([, secret]) => secret));
      process.stdout.write(formatDotEnv(args.reveal ? printable : maskConfigSecrets(printable, marked)));
      return 0;
    }
    // The deployment view: what `up --prod` hands the service, with the deployment's values
    // (process env, then the use_env file, then config) and only the keys it forwards.
    const effective = buildEffectiveEnv(config, service, baseEnv, generatedEnv, assignments, secrets);
    process.stdout.write(formatDotEnv(maskSecrets(effective, args.reveal, secrets)));
    return 0;
  });
}
