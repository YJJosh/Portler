import { didYouMean } from '../util/suggest.ts';

export interface ParsedArgs {
  file?: string;
  detach: boolean;
  follow: boolean;
  help: boolean;
  global: boolean;
  ports: boolean;
  force: boolean;
  /** `down k8s --volumes`: also delete PersistentVolumeClaims (destroys data). */
  volumes: boolean;
  volumeSet?: string;
  /** `--image <service>=<image>`: run that Docker service from this image instead of building it (up/restart). */
  images?: Record<string, string>;
  positionals: string[];
}

/** Every flag the CLI accepts, for unknown-flag rejection and suggestions. */
const KNOWN_FLAGS = [
  '--help',
  '--detach',
  '--global',
  '--ports',
  '--force',
  '--follow',
  '--volumes',
  '--volume-set',
  '--file',
  '--image',
];

/**
 * `-f` is overloaded across the CLI, so it is resolved per command rather than
 * globally: for `logs` it means `--follow` (what `docker logs -f` / `kubectl
 * logs -f` train users to expect, and `portler logs -f api` previously parsed
 * "api" as a config FILE path and then reported no logs), everywhere else it
 * keeps its `--file` meaning. `--file`/`--follow` in long form are unambiguous
 * everywhere.
 */
function shortFMeansFollow(command: string): boolean {
  return command === 'logs';
}

/**
 * `--image api=ghcr.io/org/api@sha256:...` pins the image a Docker service runs
 * from. The split is at the first "=": a service name never contains one, and
 * neither does an image reference (registry/name:tag@digest).
 */
function addImageOverride(parsed: ParsedArgs, spec: string): void {
  const separator = spec.indexOf('=');
  const service = separator > 0 ? spec.slice(0, separator) : '';
  const image = separator >= 0 ? spec.slice(separator + 1) : '';
  if (!service || !image) throw new Error(`--image expects <service>=<image>, got "${spec}"`);
  if (/\s/.test(image)) throw new Error(`--image ${service}: image reference "${image}" must not contain whitespace`);

  parsed.images ??= {};
  if (parsed.images[service] !== undefined) throw new Error(`--image given twice for service "${service}"`);
  parsed.images[service] = image;
}

/** Parse the argv tail (everything after the command) into structured flags. */
export function parseArgs(args: string[], command = ''): ParsedArgs {
  const positionals: string[] = [];
  const parsed: ParsedArgs = {
    detach: false,
    follow: false,
    help: false,
    global: false,
    ports: false,
    force: false,
    volumes: false,
    positionals,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--') {
      positionals.push(...args.slice(index + 1));
      break;
    }

    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }

    if (arg === '-d' || arg === '--detach') {
      parsed.detach = true;
      continue;
    }

    if (arg === '--global') {
      parsed.global = true;
      continue;
    }

    if (arg === '--ports') {
      parsed.ports = true;
      continue;
    }

    if (arg === '--force') {
      parsed.force = true;
      continue;
    }

    if (arg === '--volumes') {
      parsed.volumes = true;
      continue;
    }

    if (arg === '--follow' || (arg === '-f' && shortFMeansFollow(command))) {
      parsed.follow = true;
      continue;
    }

    if (arg === '--volume-set') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a name`);
      parsed.volumeSet = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--volume-set=')) {
      const value = arg.slice('--volume-set='.length);
      if (!value) throw new Error('--volume-set requires a name');
      parsed.volumeSet = value;
      continue;
    }

    if (arg === '-f' || arg === '--file') {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a path`);
      parsed.file = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--file=')) {
      const value = arg.slice('--file='.length);
      if (!value) throw new Error('--file requires a path');
      parsed.file = value;
      continue;
    }

    if (arg === '--image') {
      const value = args[index + 1];
      if (!value) throw new Error('--image requires <service>=<image>');
      addImageOverride(parsed, value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--image=')) {
      const value = arg.slice('--image='.length);
      if (!value) throw new Error('--image requires <service>=<image>');
      addImageOverride(parsed, value);
      continue;
    }

    // Anything else that looks like a flag is a typo or a flag from another
    // tool. Passing it through as a positional used to surface as a confusing
    // "unknown service \"--detatch\"" (or, worse, be silently ignored).
    if (arg.startsWith('-') && arg !== '-') {
      const name = arg.split('=')[0]!;
      throw new Error(`unknown flag "${name}"${didYouMean(name, KNOWN_FLAGS)}. Run "portler --help" to see the available flags.`);
    }

    positionals.push(arg);
  }

  return parsed;
}
