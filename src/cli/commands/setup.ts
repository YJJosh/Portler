import { configForRunMode, loadBaseEnv, loadConfig } from '../../config/index.ts';
import { applyProduction } from '../../config/production.ts';
import { buildServiceEnv } from '../../env/index.ts';
import { buildProjectEnv, runSetupStep } from '../../setup/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, parseRunMode, validateDockerMode } from '../services.ts';
import { ensureAssignments } from './env.ts';

export async function commandSetup(args: ParsedArgs): Promise<number> {
  const { mode, requested } = parseRunMode(args.positionals);
  if (mode === 'k8s') throw new Error('setup does not support k8s mode; run setup on the host before building images');
  const rawConfig = await loadConfig(process.cwd(), args.file);
  const config = applyProduction(configForRunMode(rawConfig, mode), args.prod);
  const names = expandAndOrderServices(config, requested);
  if (mode === 'docker') validateDockerMode(config, names);
  return withLifecycleLock(config.projectDir, async () => {
    const { assignments, generatedEnv } = await ensureAssignments(config);
    const baseEnv = await loadBaseEnv(config);
    const setupMode = `${mode}:${args.prod ? 'prod' : 'dev'}`;
    await runSetupStep(config, null, buildProjectEnv(config, baseEnv, assignments), setupMode, true);
    for (const name of names) {
      const service = config.services[name]!;
      await runSetupStep(config, service, buildServiceEnv(config, service, baseEnv, generatedEnv, assignments).env, setupMode, true);
    }
    return 0;
  });
}
