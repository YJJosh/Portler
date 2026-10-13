import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { portlerDir } from '../state/index.ts';

/** The `.portler/logs/` directory holding captured output of detached services. */
export function logsDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'logs');
}

/** The log file capturing one detached service's stdout/stderr. */
export function serviceLogPath(projectDir: string, serviceName: string): string {
  return path.join(logsDir(projectDir), `${serviceName}.log`);
}

/**
 * Start a fresh captured log generation. Create the new inode before replacing
 * the old one so even a restart between follower polls is detectable, without
 * an interval where the log path is missing (or immediate inode reuse).
 * The caller owns the returned descriptor.
 */
export function openServiceLog(filePath: string): number {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const fd = openSync(tempPath, 'wx');
  try {
    renameSync(tempPath, filePath);
    return fd;
  } catch (error) {
    closeSync(fd);
    unlinkSync(tempPath);
    throw error;
  }
}

export interface LinePrinter {
  write(chunk: Buffer | string): void;
  flush(): void;
}

/**
 * Buffer arbitrary chunks and emit whole lines prefixed with the service name
 * so interleaved logs stay readable. `flush` emits a trailing partial line.
 */
export function createLinePrinter(serviceName: string, output: NodeJS.WritableStream): LinePrinter {
  let buffer = '';
  const prefix = `[${serviceName}]`;

  return {
    write(chunk: Buffer | string): void {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        output.write(`${prefix} ${line}\n`);
      }
    },
    flush(): void {
      if (buffer.length > 0) {
        output.write(`${prefix} ${buffer}\n`);
        buffer = '';
      }
    },
  };
}

/** Pipe a child's output stream to ours line-by-line with a service prefix. */
export function prefixStream(serviceName: string, stream: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  const printer = createLinePrinter(serviceName, output);

  stream.on('data', (chunk: Buffer | string) => printer.write(chunk));
  stream.on('end', () => printer.flush());
}
