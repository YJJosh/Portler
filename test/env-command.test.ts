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

describe('env for a Kubernetes service without a port', () => {
  // `up k8s` records a service only through its port-forward, so one without a port has
  // no pids.json entry: env asks the cluster, but only when this checkout rendered manifests.
  const K8S_CONFIG = `services:
  worker:
    command: node worker.js
    env: {MODE: local}
    docker:
      image: example/worker
      env: {MODE: docker}
`;
  let calls: string;

  async function fakeKubectl(script: string[]): Promise<void> {
    const bin = path.join(projectDir, 'bin');
    calls = path.join(projectDir, 'kubectl-calls');
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(
      path.join(bin, 'kubectl'),
      ['#!/bin/sh', `echo "$*" >> '${calls}'`, 'case "$*" in', ...script, 'esac', 'exit 0', ''].join('\n'),
      { mode: 0o755 },
    );
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
  }

  /** What `up k8s` leaves in .portler/k8s/: the namespace file plus one file per service it rendered. */
  async function renderedManifest(services: string[] = ['worker']): Promise<void> {
    const dir = path.join(projectDir, '.portler', 'k8s');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '00-namespace.yml'), 'kind: Namespace\n', 'utf8');
    for (const name of services) await fs.writeFile(path.join(dir, `${name}.yml`), 'kind: Deployment\n', 'utf8');
  }

  /** A worker entry whose pid has exited: a launch that has since stopped. */
  async function stoppedRecord(info: Partial<PidServiceInfo>): Promise<void> {
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: { worker: { pid: Number(child.stdout), command: 'x', cwd: projectDir, startedAt, ...info } },
    });
  }

  const cluster = ['  "config current-context") echo docker-desktop ;;', '  "config view"*) echo https://127.0.0.1:6443 ;;'];

  beforeEach(async () => {
    await fs.writeFile(path.join(projectDir, 'portler.yml'), K8S_CONFIG, 'utf8');
  });

  it('shows the k8s environment when the cluster runs its Deployment', async () => {
    await renderedManifest();
    await fakeKubectl([...cluster, `  *" get deployment "*) echo deployment.apps/worker ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'docker');
    assert.match(result.stderr, /worker was started with "portler up k8s"; this shows the environment it got/);
  });

  it('keeps the development view when the cluster has no Deployment for it', async () => {
    await renderedManifest();
    await fakeKubectl([...cluster, `  *" get deployment "*) echo 'No resources found' ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'local');
    assert.equal(result.stderr, '');
  });

  it('never asks kubectl when this checkout rendered no Kubernetes manifests', async () => {
    await fakeKubectl([...cluster, `  *" get deployment "*) echo deployment.apps/worker ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'local');
    await assert.rejects(fs.access(calls));
  });

  it('still asks the cluster after a later up k8s rendered only another service', async () => {
    // Every render replaces .portler/k8s/, so `up k8s other` drops worker.yml while worker runs on.
    await renderedManifest(['other']);
    await fakeKubectl([...cluster, `  *" get deployment "*) echo deployment.apps/worker ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'docker');
  });

  it('asks the cluster when the only entry is a local launch that has stopped', async () => {
    await stoppedRecord({ runMode: 'local' });
    await renderedManifest();
    await fakeKubectl([...cluster, `  *" get deployment "*) echo deployment.apps/worker ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'docker');
    assert.match(result.stderr, /worker was started with "portler up k8s"/);
  });

  it('keeps a stopped entry\'s launch when the cluster has no Deployment for it', async () => {
    await stoppedRecord({ runMode: 'local', prod: true });
    await renderedManifest();
    await fakeKubectl([...cluster, `  *" get deployment "*) echo 'No resources found' ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /worker was started with "portler up --prod"/);
  });

  it('never asks the cluster about a service whose entry still runs', async () => {
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: { worker: { pid: process.pid, command: 'x', cwd: projectDir, startedAt, runMode: 'local' } },
    });
    await renderedManifest();
    await fakeKubectl([...cluster, `  *" get deployment "*) echo deployment.apps/worker ;;`]);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'local');
    await assert.rejects(fs.access(calls));
  });

  it('says so when the cluster cannot be asked, and shows the development view', async () => {
    await renderedManifest();
    await fakeKubectl(['  "config current-context") echo "no context" >&2; exit 1 ;;']);
    const result = run('worker');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'MODE'), 'local');
    assert.match(result.stderr, /could not ask the cluster whether worker runs there/);
  });
});
