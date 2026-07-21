import { configForRunMode, loadConfig } from '../../config/index.ts';
import { renderManifests, writeManifestFiles } from '../../k8s/index.ts';
import { withLifecycleLock } from '../../state/lock.ts';
import type { ParsedArgs } from '../args.ts';
import { expandAndOrderServices, selectServiceNames } from '../services.ts';
import { ensureAssignments } from './env.ts';
import { validateK8sMode } from './up-k8s.ts';

/**
 * `portler k8s render [service...]`: generate the Kubernetes YAML into
 * `.portler/k8s/` and print it, without building images or applying anything.
 */
export async function commandK8s(args: ParsedArgs): Promise<number> {
  const [subcommand, ...requested] = args.positionals;
  if (subcommand !== 'render') {
    throw new Error('unknown k8s subcommand. Usage: portler k8s render [service...]');
  }

  const rawConfig = await loadConfig(process.cwd(), args.file);
  const requestedRootNames = selectServiceNames(rawConfig, requested);
  const selectedNames = expandAndOrderServices(rawConfig, requestedRootNames);
  const config = configForRunMode(rawConfig, 'k8s');

  validateK8sMode(config, selectedNames);

  return withLifecycleLock(config.projectDir, async () => {
    const { assignments } = await ensureAssignments(config);
    const rendered = await renderManifests(config, selectedNames, assignments);
    const manifestDir = await writeManifestFiles(config.projectDir, rendered);

    for (const file of rendered.files) {
      process.stdout.write(file.text);
    }
    process.stderr.write(`[portler] wrote ${rendered.files.length} manifest files to ${manifestDir}\n`);

    return 0;
  });
}
