import { spawn } from 'node:child_process';

export interface DockerCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a docker CLI command, capturing output. Rejects only when docker is not installed. */
export function runDocker(args: string[]): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('docker CLI not found in PATH. Install Docker to manage volumes.'));
        return;
      }
      reject(error);
    });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run a docker CLI command and throw a readable error when it fails. */
export async function dockerOrThrow(args: string[]): Promise<string> {
  const result = await runDocker(args);

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`"docker ${args.slice(0, 2).join(' ')}" failed: ${detail}`);
  }

  return result.stdout;
}

/** Fail fast with a clear message when the Docker daemon is not reachable. */
export async function ensureDockerRunning(): Promise<void> {
  const result = await runDocker(['version', '--format', '{{.Server.Version}}']);

  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n')[0] ?? '';
    throw new Error(`Docker daemon is not reachable${detail ? ` (${detail})` : ''}. Start Docker and retry.`);
  }
}
