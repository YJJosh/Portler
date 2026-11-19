import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { portlerDir } from '../state/index.ts';

export function logsDir(projectDir: string): string {
  return path.join(portlerDir(projectDir), 'logs');
}

export function serviceLogPath(projectDir: string, serviceName: string): string {
  return path.join(logsDir(projectDir), `${serviceName}.log`);
}

/**
 * Renames a new inode over the old log, so followers detect even a quick restart and the path
 * never goes missing. The caller owns the returned descriptor.
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

/** Emits whole lines with a `[service]` prefix; `flush` emits a trailing partial line. */
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

export function prefixStream(serviceName: string, stream: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
  const printer = createLinePrinter(serviceName, output);

  stream.on('data', (chunk: Buffer | string) => printer.write(chunk));
  stream.on('end', () => printer.flush());
}
