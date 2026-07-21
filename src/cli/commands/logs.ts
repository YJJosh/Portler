import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { loadConfig } from '../../config/index.ts';
import { createLinePrinter, prefixStream, readPids, serviceLogPath } from '../../process/index.ts';
import { pathExists } from '../../util/fs.ts';
import { sleep } from '../../util/sleep.ts';
import type { ParsedArgs } from '../args.ts';
import { selectServiceNames } from '../services.ts';

const FOLLOW_POLL_MS = 250;

/** Where one service's logs live: its Docker container or a captured log file. */
type LogSource =
  | { serviceName: string; kind: 'docker'; containerName: string }
  | { serviceName: string; kind: 'file'; filePath: string };

function containerExists(containerName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['inspect', containerName], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** Stream `docker logs` for one container, prefixing lines with the service name. */
function streamDockerLogs(serviceName: string, containerName: string, follow: boolean): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['logs', ...(follow ? ['--follow'] : []), containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.stdout) prefixStream(serviceName, child.stdout, process.stdout);
    if (child.stderr) prefixStream(serviceName, child.stderr, process.stderr);
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

/** Print a captured log file once, prefixing lines with the service name. */
async function printLogFile(serviceName: string, filePath: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf8').catch(() => '');
  const printer = createLinePrinter(serviceName, process.stdout);

  printer.write(content);
  printer.flush();
}

/**
 * Tail a captured log file forever: print what exists, then poll for appended
 * bytes. A restarted service truncates its file, so a shrink starts over.
 */
async function followLogFile(serviceName: string, filePath: string): Promise<void> {
  const printer = createLinePrinter(serviceName, process.stdout);
  let position = 0;

  for (;;) {
    const stats = await fs.stat(filePath).catch(() => null);

    if (stats && stats.size < position) position = 0;
    if (stats && stats.size > position) {
      const handle = await fs.open(filePath, 'r');
      try {
        const length = stats.size - position;
        const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, position);
        printer.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      } finally {
        await handle.close();
      }
    }

    await sleep(FOLLOW_POLL_MS);
  }
}

/**
 * Resolve each requested service to its log source: a live Docker container
 * wins (delegating to `docker logs`), otherwise the `.portler/logs/` file
 * written by `up --detach`.
 */
async function resolveLogSources(projectDir: string, serviceNames: string[], explicit: boolean): Promise<LogSource[]> {
  const pids = await readPids(projectDir);
  const sources: LogSource[] = [];

  for (const serviceName of serviceNames) {
    const containerName = pids?.services[serviceName]?.dockerContainer;
    const filePath = serviceLogPath(projectDir, serviceName);

    if (containerName && (await containerExists(containerName))) {
      sources.push({ serviceName, kind: 'docker', containerName });
    } else if (await pathExists(filePath)) {
      sources.push({ serviceName, kind: 'file', filePath });
    } else if (explicit) {
      process.stderr.write(`[portler] no logs for "${serviceName}". Logs are captured for services started with "portler up -d".\n`);
    }
  }

  return sources;
}

/** Exit quietly when the downstream pipe closes, e.g. `portler logs | head`. */
function exitOnClosedStdout(): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

export async function commandLogs(args: ParsedArgs): Promise<number> {
  exitOnClosedStdout();

  const config = await loadConfig(process.cwd(), args.file);
  const serviceNames = selectServiceNames(config, args.positionals);
  const sources = await resolveLogSources(config.projectDir, serviceNames, args.positionals.length > 0);

  if (sources.length === 0) {
    process.stdout.write('[portler] no logs found. Start services with "portler up -d" first.\n');
    return args.positionals.length > 0 ? 1 : 0;
  }

  if (args.follow) {
    // File followers never resolve; Ctrl+C ends the stream.
    await Promise.all(
      sources.map((source) => {
        return source.kind === 'docker'
          ? streamDockerLogs(source.serviceName, source.containerName, true)
          : followLogFile(source.serviceName, source.filePath);
      }),
    );
    return 0;
  }

  for (const source of sources) {
    if (source.kind === 'docker') await streamDockerLogs(source.serviceName, source.containerName, false);
    else await printLogFile(source.serviceName, source.filePath);
  }

  return 0;
}
