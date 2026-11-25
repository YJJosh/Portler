import { didYouMean } from '../util/suggest.ts';

export interface ParsedArgs {
  file?: string;
  prod?: boolean;
  setup?: boolean;
  detach: boolean;
  /** `env --prod`: print secret-looking values instead of masking them. */
  reveal: boolean;
  /** `start`: how long to wait for the rest of the process group after the shell exits. */
  drainMs?: number;
  follow: boolean;
  help: boolean;
  global: boolean;
  ports: boolean;
  force: boolean;
  /** `down k8s --volumes`: also delete PersistentVolumeClaims (destroys data). */
  volumes: boolean;
  /** `volumes list --json`: machine-readable output for other tools. */
  json: boolean;
  volumeSet?: string;
  /** `--image <service>=<image>`: run that Docker service from this image instead of building it (up/restart). */
  images?: Record<string, string>;
  positionals: string[];
  /** The words after `--`, when there is one; they are in `positionals` too. `run` passes them on as a command. */
  passthrough?: string[];
}

const KNOWN_FLAGS = [
  '--prod',
  '--setup',
  '--no-setup',
  '--reveal',
  '--drain-ms',
  '--help',
  '--detach',
  '--global',
  '--ports',
  '--force',
  '--follow',
  '--volumes',
  '--json',
  '--volume-set',
  '--file',
  '--image',
];

// The longest delay a Node timer accepts.
const MAX_DRAIN_MS = 2_147_483_647;

// `-f` is `--follow` for `logs` (as in `docker logs -f`), `--file` elsewhere.
function shortFMeansFollow(command: string): boolean {
  return command === 'logs';
}

// Split at the first "=": neither a service name nor an image reference contains one.
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

/** `args` is the argv after the command. */
export function parseArgs(args: string[], command = ''): ParsedArgs {
  const positionals: string[] = [];
  const parsed: ParsedArgs = {
    detach: false,
    reveal: false,
    follow: false,
    help: false,
    global: false,
    ports: false,
    force: false,
    volumes: false,
    json: false,
    positionals,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--') {
      parsed.passthrough = args.slice(index + 1);
      positionals.push(...parsed.passthrough);
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

    if (arg === '--prod') {
      parsed.prod = true;
      continue;
    }

    if (arg === '--setup' || arg === '--no-setup') {
      const setup = arg === '--setup';
      if (parsed.setup !== undefined && parsed.setup !== setup) throw new Error('--setup and --no-setup cannot be combined');
      parsed.setup = setup;
      continue;
    }

    if (arg === '--global') {
      parsed.global = true;
      continue;
    }

    if (arg === '--reveal') {
      parsed.reveal = true;
      continue;
    }

    if (arg === '--drain-ms' || arg.startsWith('--drain-ms=')) {
      const value = arg === '--drain-ms' ? args[index + 1] : arg.slice('--drain-ms='.length);
      if (value === undefined || !/^\d+$/.test(value)) throw new Error('--drain-ms requires a number of milliseconds');
      // Enough digits make Number() Infinity, a deadline never reached, so start
      // would never kill what the shell leaves behind.
      const drainMs = Number(value);
      if (drainMs > MAX_DRAIN_MS) throw new Error(`--drain-ms must be at most ${MAX_DRAIN_MS} (about 24.8 days)`);
      parsed.drainMs = drainMs;
      if (arg === '--drain-ms') index += 1;
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

    if (arg === '--json') {
      parsed.json = true;
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

    // A typo or another tool's flag would otherwise read as a service name.
    if (arg.startsWith('-') && arg !== '-') {
      const name = arg.split('=')[0]!;
      throw new Error(`unknown flag "${name}"${didYouMean(name, KNOWN_FLAGS)}. Run "portler --help" to see the available flags.`);
    }

    positionals.push(arg);
  }

  return parsed;
}
