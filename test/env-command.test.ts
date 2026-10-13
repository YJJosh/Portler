/**
 * `portler env <service>` for a service that is running: it prints the
 * environment of the launch pids.json records (run mode and --prod), not the
 * plain development view. These drive the real CLI against a temp project with
 * a hand-written pids.json; nothing is started.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writePids } from '../src/process/pids.ts';
import type { PidServiceInfo } from '../src/types/index.ts';

const CONFIG = `services:
  postgres:
    image: postgres:16-alpine
    port: 5432
  backend:
    command: node server.js
    port: 4000
    port_env: PORT
    depends_on: [postgres]
    env:
      DATABASE_URL: "postgres://app:app@localhost:\${postgres.port}/app"
      MODE: local
    docker:
      image: example/backend
      env:
        DATABASE_URL: "postgres://app:app@postgres:5432/app"
        MODE: docker
    prod:
      env: {MODE: prod, API_TOKEN: secret-value}
`;

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
let projectDir: string;
let env: Record<string, string>;

beforeEach(async () => {
  projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-env-cmd-')));
  await fs.writeFile(path.join(projectDir, 'portler.yml'), CONFIG, 'utf8');
  env = { ...(process.env as Record<string, string>), PORTLER_GLOBAL_DIR: path.join(projectDir, 'global') };
  delete env.DATABASE_URL;
  delete env.MODE;
  delete env.PORT;
  delete env.API_TOKEN;
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, 'env', ...args], { cwd: projectDir, env, encoding: 'utf8' });
}

async function record(backend: Partial<PidServiceInfo>): Promise<void> {
  const startedAt = new Date().toISOString();
  await writePids(projectDir, {
    version: 1,
    project: projectDir,
    startedAt,
    services: { backend: { pid: process.pid, command: 'x', cwd: projectDir, startedAt, ...backend } },
  });
}

function value(stdout: string, key: string): string | undefined {
  const match = new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm').exec(stdout);
  return match?.[1];
}

describe('env for a running service', () => {
  it('prints the Docker-mode environment for a service started with "up docker"', async () => {
    await record({ runMode: 'docker', dockerContainer: 'c-backend' });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'DATABASE_URL'), 'postgres://app:app@postgres:5432/app');
    assert.equal(value(result.stdout, 'MODE'), 'docker');
    assert.equal(value(result.stdout, 'PORT'), '4000', 'port_env is the container port inside the container');
    assert.match(result.stderr, /backend was started with "portler up docker"; this shows the environment it got/);
  });

  it('infers Docker mode for an entry written before runMode was recorded', async () => {
    await record({ dockerContainer: 'c-backend' });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'docker');
  });

  it('prints the production view for a service started with --prod, and lets --reveal show it', async () => {
    await record({ runMode: 'docker', dockerContainer: 'c-backend', prod: true });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'prod');
    assert.equal(value(result.stdout, 'DATABASE_URL'), 'postgres://app:***@postgres:5432/app');
    assert.equal(value(result.stdout, 'API_TOKEN'), '***');
    assert.match(result.stderr, /started with "portler up docker --prod"; this shows the environment it got/);
    assert.equal(value(run('backend', '--reveal').stdout, 'API_TOKEN'), 'secret-value');
  });

  it('lets a typed mode token or --prod override the record, and says so', async () => {
    await record({ runMode: 'docker', dockerContainer: 'c-backend' });
    const prod = run('backend', '--prod');
    assert.equal(prod.status, 0, prod.stderr);
    assert.equal(value(prod.stdout, 'MODE'), 'prod');
    assert.equal(value(prod.stdout, 'DATABASE_URL'), 'postgres://app:***@postgres:5432/app', 'still the recorded Docker mode');
    assert.match(prod.stderr, /started with "portler up docker"; this shows what "portler up docker --prod" would give it instead/);

    await record({ runMode: 'local' });
    const docker = run('docker', 'backend');
    assert.equal(docker.status, 0, docker.stderr);
    assert.equal(value(docker.stdout, 'MODE'), 'docker');
    assert.match(docker.stderr, /started with "portler up"; this shows what "portler up docker" would give it instead/);
  });

  it('keeps the local development view, without a notice, for a local or stopped service', async () => {
    const stopped = run('backend');
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(value(stopped.stdout, 'MODE'), 'local');
    assert.match(value(stopped.stdout, 'DATABASE_URL') ?? '', /^postgres:\/\/app:app@localhost:\d+\/app$/);
    assert.notEqual(value(stopped.stdout, 'PORT'), '4000');
    assert.equal(stopped.stderr, '');

    await record({ runMode: 'local' });
    const local = run('backend');
    assert.equal(local.status, 0, local.stderr);
    assert.equal(value(local.stdout, 'MODE'), 'local');
    assert.equal(local.stderr, '');
    assert.match(run('backend', '--reveal').stderr, /--reveal applies to "env --prod"/);
  });

  it('refuses --prod for a service started with "up k8s", which has no production mode', async () => {
    await record({ runMode: 'k8s' });
    const result = run('backend', '--prod');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--prod does not apply to k8s mode, and backend was started with "portler up k8s"/);
  });
});
