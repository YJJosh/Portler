import { assertServiceCwd, configForRunMode, loadBaseEnv, loadConfig } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { assertEnvRequirements, buildServiceEnv } from '../../env/index.ts';
import { buildProjectEnv, pruneSetupReceipts, runSetupStep, setupModeKey } from '../../setup/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { EnvMap } from '../../types/index.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, validateDockerMode } from '../services.ts';
import { ensureAssignments } from './env.ts';

export async function commandSetup(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  if (mode === 'k8s') throw new Error('setup does not support k8s mode; run setup on the host before building images');
  const rawConfig = productionServices(await loadConfig(process.cwd(), args.file), args.prod, requested);
  const config = applyProduction(configForRunMode(rawConfig, mode), args.prod);
  const names = expandAndOrderServices(config, requested);
  if (mode === 'docker') validateDockerMode(config, names);
  // Check every selected cwd, also of services without steps, so a missing one fails
  // before any project step has side effects, as in `up`.
  for (const name of names) assertServiceCwd(config, config.services[name]!);
  return withLifecycleLock(config.projectDir, async () => {
    const { assignments, generatedEnv } = await ensureAssignments(config);
    // Setup often creates the env file on a fresh checkout, so a missing one is allowed
    // here in every mode. `up` in development still requires it.
    const baseEnv = await loadBaseEnv(config, { allowMissing: true });
    assertEnvRequirements(config, names, baseEnv);
    // Only build the project view for project steps: it rejects `self.*` in shared env.
    const projectEnv = config.setup?.length ? buildProjectEnv(config, baseEnv, assignments, generatedEnv) : {};
    // Setup steps run on this machine, also for a container service, so they get its env as
    // seen from here: `${db.address}` is the database's port on this machine, not its alias.
    const serviceEnvs = new Map<string, EnvMap>();
    for (const name of names) {
      serviceEnvs.set(name, buildServiceEnv(config, config.services[name]!, baseEnv, generatedEnv, assignments, { viewer: 'host' }).env);
    }
    // Check the resolved values too, before any setup step runs.
    assertEnvRequirements(config, names, baseEnv, { projectEnv, envs: serviceEnvs });
    const setupMode = setupModeKey(config, mode, args.prod);
    await pruneSetupReceipts(config, setupMode);
    await runSetupStep(config, null, projectEnv, setupMode, true);
    for (const name of names) {
      await runSetupStep(config, config.services[name]!, serviceEnvs.get(name)!, setupMode, true);
    }
    return 0;
  });
}
