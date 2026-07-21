import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ForwardSpec } from '../src/k8s/forward-supervisor.ts';

let tempDir: string;
let callsFile: string;
let previousPath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-forward-supervisor-'));
  callsFile = path.join(tempDir, 'calls');
  const binDir = path.join(tempDir, 'bin');
  await fs.mkdir(binDir);
  await fs.writeFile(
    path.join(binDir, 'kubectl'),
    `#!/bin/sh\nprintf 'call\\n' >> "$MOCK_FORWARD_CALLS"\nexit 1\n`,
    { mode: 0o755 },
  );
  previousPath = process.env.PATH ?? '';
  process.env.PATH = `${binDir}${path.delimiter}${previousPath}`;
});

afterEach(async () => {
  process.env.PATH = previousPath;
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('port-forward supervisor shutdown', () => {
  it('does not start a new kubectl while shutting down during reconnect backoff', async () => {
    const spec: ForwardSpec = {
      serviceName: 'api',
      k8sName: 'api',
      namespace: 'portler-test',
      localPort: 55123,
      targetPort: 8080,
      address: '127.0.0.1',
      context: 'docker-desktop',
    };
    const entrypoint = path.resolve('bin/portler.ts');
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', entrypoint, '__k8s-forward', JSON.stringify(spec)],
      {
        env: { ...process.env, MOCK_FORWARD_CALLS: callsFile },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    let stderr = '';
    const sawBackoff = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`supervisor never entered backoff: ${stderr}`)), 3_000);
      child.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes('reconnecting in 1s')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    try {
      await sawBackoff;
      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('supervisor did not exit after SIGTERM')), 3_000);
        child.once('exit', (exitCode) => {
          clearTimeout(timeout);
          resolve(exitCode);
        });
      });
      assert.equal(code, 0);
      const calls = await fs.readFile(callsFile, 'utf8');
      assert.equal(calls.trim().split('\n').length, 1, 'SIGTERM during backoff must not launch another kubectl');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
