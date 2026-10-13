import { existsSync } from 'node:fs';
import path from 'node:path';
import { applyProduction, productionServices } from '../../config/production.ts';
import { applyImageOverrides, configForRunMode, loadBaseEnv, loadConfig, type RunMode } from '../../config/index.ts';
import { PROXY_SERVICE_NAME } from '../../constants.ts';
import { assertRequiredEnv, blankRequiredKeys, buildEffectiveEnv, buildGeneratedEnv, buildPrintableEnv, deploymentEnv, maskSecrets, requiredEnvKeys } from '../../env/index.ts';
import { deployedK8sServices, detectCluster, k8sManifestDir, k8sServiceNames, NAMESPACE_MANIFEST_FILE } from '../../k8s/index.ts';
import { formatDotEnv } from '../../parse/dotenv.ts';
import { allocateAssignments } from '../../ports/index.ts';
import { readPids, runningServices, serviceLiveness } from '../../process/index.ts';
import { readState, writeRuntimeEnv, writeState } from '../../state/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { Assignments, EnvMap, PidServiceInfo, PortlerConfig, ServiceAssignment, ServiceConfig } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, recordedRunMode, selectServiceNames, servicesWithPorts, validateDockerMode } from '../services.ts';
import { validateK8sMode } from './up-k8s.ts';

/**
 * A cached assignment as a fresh allocation for this config would give it: a service that
 * is no container here gets no container name or image. state.json keeps whichever run mode
 * last allocated (an `env docker` view, or an `up docker` that has since stopped), and the
 * local view must not name that container.
 */
function asAllocatedFor(config: PortlerConfig, name: string, assignment: ServiceAssignment): ServiceAssignment {
  const service = config.services[name];
  if (!service || service.docker) return assignment;
  const copy = { ...assignment };
  delete copy.containerName;
  delete copy.image;
  return copy;
}

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
    const cached = Object.entries(state.services).filter(([name]) => configured.has(name));
    const assignments: Assignments = Object.assign(
      Object.create(null) as Assignments,
      Object.fromEntries(cached.map(([name, assignment]) => [name, asAllocatedFor(config, name, assignment)])),
    );
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

/**
 * The `--image` pins of the containers that still run in `mode` (a Docker container's entry,
 * or a Kubernetes service's port-forward; only a service with a port has an image to show).
 * state.json normally
 * carries the pinned image from that `up`, but when it is missing or incomplete the
 * assignments are rebuilt from the config, and without the pins `PORTLER_<SERVICE>_IMAGE`
 * and `${service.image}` would name the image in portler.yml instead of the one the
 * container runs. A pin from a launch in another run mode, or of a service that is no
 * longer a container in this view, describes nothing shown here and is left out. A
 * stopped entry's pin is kept only for `lastLaunch`, the service whose last launch this
 * view shows: its image is part of what that launch got.
 */
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

/** The `up` command line for a launch, as the env notices name it. */
function upCommand(mode: RunMode, prod: boolean): string {
  return `portler up${mode === 'local' ? '' : ` ${mode}`}${prod ? ' --prod' : ''}`;
}

/**
 * Whether the cluster runs a service that pids.json does not show as running. `up k8s`
 * records a service only through its port-forward, so one without a port leaves no
 * entry, and an older entry that has stopped (a local launch that exited) says nothing
 * about a later `up k8s`: the cluster is the only witness. kubectl is only asked when
 * this checkout has rendered Kubernetes manifests (every render writes the namespace
 * file), so a project that never used k8s mode never waits on it. Undefined when the
 * cluster could not be asked.
 */
async function deployedInCluster(config: PortlerConfig, serviceName: string): Promise<boolean | undefined> {
  if (!existsSync(path.join(k8sManifestDir(config.projectDir), NAMESPACE_MANIFEST_FILE))) return false;
  try {
    k8sServiceNames(Object.keys(config.services));
  } catch {
    return false;
  }
  try {
    const deployed = await deployedK8sServices(await detectCluster(), config);
    return deployed === undefined ? undefined : deployed.includes(serviceName);
  } catch {
    return undefined;
  }
}

export async function commandEnv(args: ParsedArgs): Promise<number> {
  const { mode: requestedMode, requested } = parseRunMode(args.positionals);
  const modeExplicit = requested.length < args.positionals.length;
  if (requested.length > 1) throw new Error('env accepts at most one service name');
  const loadedConfig = await loadConfig(process.cwd(), args.file);

  const serviceName = requested[0];
  if (serviceName && !loadedConfig.services[serviceName]) throw new Error(`unknown service "${serviceName}"`);

  return withLifecycleLock(loadedConfig.projectDir, async () => {
    // A service with a pids.json entry, live or stale, is shown as it was started: in its
    // run mode and, if it was started with --prod, in production. A typed mode token or
    // --prod wins over the record, as it does for restart, and a notice says so.
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
    if (args.reveal && !prod) {
      throw new Error('--reveal applies to "env --prod" (or a service started with --prod): the development view prints config values, not the deployment\'s secrets');
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
    // A typed mode token must describe a launch that could happen: refuse what `up docker`
    // or `up k8s` would refuse instead of printing an environment no launch could get. Like
    // `up`, check the service together with everything it depends on, and every service
    // when none is named.
    if (modeExplicit && mode !== 'local') {
      const launched = expandAndOrderServices(config, selectServiceNames(config, service ? [service.name] : []));
      if (mode === 'docker') validateDockerMode(config, launched);
      else validateK8sMode(config, launched);
    }

    // A partial `up` rewrites state.json with only its own pins, so a cached image can name
    // portler.yml's image while a running container's pids.json entry still holds its pin.
    const { assignments: cached } = await ensureAssignments(config);
    const assignments: Assignments = Object.assign(Object.create(null) as Assignments, cached);
    for (const [name, image] of Object.entries(pins)) {
      if (assignments[name]) assignments[name] = { ...assignments[name], image };
    }
    const generatedEnv = buildGeneratedEnv(assignments);
    // Always refresh runtime.env, even when cached state was reused, so a
    // manually deleted file comes back.
    await writeRuntimeEnv(config.projectDir, generatedEnv);

    if (!prod) {
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
