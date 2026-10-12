import { configForRunMode, loadBaseEnv, loadConfig } from '../../config/index.ts';
import { applyProduction, productionServices } from '../../config/production.ts';
import { assertRequiredEnv, buildServiceEnv, requiredEnvKeys } from '../../env/index.ts';
import { buildProjectEnv, pruneSetupReceipts, runSetupStep } from '../../setup/index.ts';
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
  return withLifecycleLock(config.projectDir, async () => {
    const { assignments, generatedEnv } = await ensureAssignments(config);
    // A missing env file is skipped in every mode here: on a fresh checkout the file is
    // often what setup (or the tool that ran it) creates, and its values are read before
    // the steps run anyway. `up` in development still requires it.
    const baseEnv = await loadBaseEnv(config, { allowMissing: true });
    const projectEnv = buildProjectEnv(config, baseEnv, assignments);
    const serviceEnvs = new Map<string, EnvMap>();
    for (const name of names) {
      serviceEnvs.set(name, buildServiceEnv(config, config.services[name]!, baseEnv, generatedEnv, assignments).env);
    }
    if (args.prod) {
      assertRequiredEnv('the project', requiredEnvKeys(config), projectEnv);
      for (const name of names) assertRequiredEnv(`service ${name}`, requiredEnvKeys(config, config.services[name]!), serviceEnvs.get(name)!);
    }
    const setupMode = `${mode}:${args.prod ? 'prod' : 'dev'}`;
    await pruneSetupReceipts(config, setupMode);
    await runSetupStep(config, null, projectEnv, setupMode, true);
    for (const name of names) {
      await runSetupStep(config, config.services[name]!, serviceEnvs.get(name)!, setupMode, true);
    }
    return 0;
  });
}
