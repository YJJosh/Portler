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
import { K8S_FORWARD_COMMAND } from '../src/k8s/kubectl.ts';
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

  it('rebuilds missing state with the --image pin the running container was started from', async () => {
    // No state.json: env allocates the assignments again, and the pin recorded in
    // pids.json, not the image in portler.yml, is what the container runs.
    await record({ runMode: 'docker', dockerContainer: 'c-backend', image: 'example/backend@sha256:pinned' });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'PORTLER_BACKEND_IMAGE'), 'example/backend@sha256:pinned');
  });

  it('rebuilds missing state with the --image pin a running Kubernetes service was started from', async () => {
    // up k8s records a ported service through its port-forward entry, which carries the pin.
    await record({ runMode: 'k8s', command: `${K8S_FORWARD_COMMAND} (kubectl port-forward service/backend 4000:4000)`, image: 'example/backend@sha256:k8s-pin' });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'PORTLER_BACKEND_IMAGE'), 'example/backend@sha256:k8s-pin');
    assert.match(result.stderr, /backend was started with "portler up k8s"; this shows the environment it got/);
  });

  it('replays a running container\'s pin over a cached image a later partial up reverted', async () => {
    await record({ runMode: 'docker', dockerContainer: 'c-backend', image: 'example/backend@sha256:pinned' });
    assert.equal(run('backend').status, 0);
    // A later `up` of another service rewrites state.json with only its own pins.
    const stateFile = path.join(projectDir, '.portler', 'state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state.services.backend.image = 'example/backend';
    await fs.writeFile(stateFile, JSON.stringify(state), 'utf8');
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'PORTLER_BACKEND_IMAGE'), 'example/backend@sha256:pinned');
  });

  it('keeps the --image pin of a stopped launch it shows as the last one', async () => {
    // The containers have exited: a fake docker reports them gone, so this does not
    // depend on a real daemon. backend's entry is the launch env shows, so its pin stays;
    // postgres's stopped entry is not shown, so its image comes from portler.yml.
    const bin = path.join(projectDir, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\necho "Error: No such object: $3" >&2\nexit 1\n', { mode: 0o755 });
    env = { ...env, PATH: `${bin}${path.delimiter}${env.PATH ?? ''}` };
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
    const startedAt = new Date().toISOString();
    const entry = { pid: dead, command: 'x', cwd: projectDir, startedAt, runMode: 'docker' as const };
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: {
        backend: { ...entry, dockerContainer: 'c-backend', image: 'example/backend@sha256:stopped-pin' },
        postgres: { ...entry, dockerContainer: 'c-postgres', image: 'postgres@sha256:other-pin' },
      },
    });
    const result = run('backend');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(value(result.stdout, 'PORTLER_BACKEND_IMAGE'), 'example/backend@sha256:stopped-pin');
    assert.equal(value(result.stdout, 'PORTLER_POSTGRES_IMAGE'), 'postgres:16-alpine');
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

  it('leaves no container name or image from a typed Docker view in the plain one', async () => {
    // `env docker` allocates (and persists) the Docker view's container metadata; the plain
    // view of a command-backed service must not name that container afterwards.
    const docker = run('docker', 'backend');
    assert.equal(docker.status, 0, docker.stderr);
    assert.ok(value(docker.stdout, 'PORTLER_BACKEND_CONTAINER'), 'the Docker view names the container');
    assert.equal(value(docker.stdout, 'PORTLER_BACKEND_IMAGE'), 'example/backend');
    const local = run('backend');
    assert.equal(local.status, 0, local.stderr);
    assert.equal(value(local.stdout, 'PORTLER_BACKEND_CONTAINER'), undefined);
    assert.equal(value(local.stdout, 'PORTLER_BACKEND_IMAGE'), undefined);
    assert.ok(value(local.stdout, 'PORTLER_POSTGRES_CONTAINER'), 'a service that is a container in the plain view keeps its name');
  });

  it('shows each view\'s own image for a container service with a docker.image override', async () => {
    // Both views name the same container, so the cached state passes the container-name
    // check; the image cached by `env docker` must not leak into the plain view.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), `${CONFIG}  api:
    image: example/api-base
    port: 5000
    docker:
      image: example/api-docker
`, 'utf8');
    const docker = run('docker', 'api');
    assert.equal(docker.status, 0, docker.stderr);
    assert.equal(value(docker.stdout, 'PORTLER_API_IMAGE'), 'example/api-docker');
    const plain = run('api');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(value(plain.stdout, 'PORTLER_API_IMAGE'), 'example/api-base');
    assert.equal(value(plain.stdout, 'PORTLER_API_CONTAINER'), value(docker.stdout, 'PORTLER_API_CONTAINER'));
  });

  describe('setup and k8s render after another view cached the image', () => {
    // api keeps one container name in every view, so state.json passes the cache check
    // with whichever image the last allocation stored.
    const IMAGES = `services:
  api:
    image: example/api-base
    port: 5000
    docker:
      image: example/api-docker
  app:
    command: node app.js
    env: {API_IMAGE: "\${api.image}"}
    docker: {image: example/app}
    setup:
      - echo "$PORTLER_API_IMAGE $API_IMAGE" > seen
`;
    const portler = (...args: string[]) =>
      spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: projectDir, env, encoding: 'utf8' });

    beforeEach(async () => {
      await fs.writeFile(path.join(projectDir, 'portler.yml'), IMAGES, 'utf8');
    });

    for (const [mode, cachedBy, expected] of [
      ['local', 'docker', 'example/api-base'],
      ['docker', 'local', 'example/api-docker'],
    ] as const) {
      it(`setup ${mode} resolves the ${mode} image after env ${cachedBy} cached the other one`, async () => {
        const cached = portler('env', ...(cachedBy === 'docker' ? ['docker'] : []), 'api');
        assert.equal(cached.status, 0, cached.stderr);
        assert.notEqual(value(cached.stdout, 'PORTLER_API_IMAGE'), expected);
        const setup = portler('setup', ...(mode === 'docker' ? ['docker'] : []), 'app');
        assert.equal(setup.status, 0, setup.stderr);
        assert.equal(await fs.readFile(path.join(projectDir, 'seen'), 'utf8'), `${expected} ${expected}\n`);
      });
    }

    it('k8s render resolves the k8s image after env cached the plain one', async () => {
      const cached = portler('env', 'api');
      assert.equal(value(cached.stdout, 'PORTLER_API_IMAGE'), 'example/api-base');
      const render = portler('k8s', 'render', 'app');
      assert.equal(render.status, 0, render.stderr);
      assert.match(render.stdout, /name: API_IMAGE\n\s+value: example\/api-docker\n/);
      assert.match(render.stdout, /name: PORTLER_API_IMAGE\n\s+value: example\/api-docker\n/);
      assert.doesNotMatch(render.stdout, /api-base/);
    });
  });

  it('refuses a typed k8s mode for a service that up k8s would refuse', async () => {
    await fs.writeFile(path.join(projectDir, 'portler.yml'), `${CONFIG}  api:
    command: node api.js
    port: 5000
`, 'utf8');
    const refused = run('k8s', 'api');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /service "api" has no container config for Kubernetes/);
    assert.equal(refused.stdout, '');

    const backend = run('k8s', 'backend');
    assert.equal(backend.status, 0, backend.stderr);
    assert.equal(value(backend.stdout, 'MODE'), 'docker');
  });

  it('refuses a typed mode when a dependency could not run in it, as up does', async () => {
    // backend has container config, but it now depends on cache, which has none.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), CONFIG.replace('depends_on: [postgres]', 'depends_on: [postgres, cache]') + `  cache:
    command: redis-server
    port: 6379
`, 'utf8');
    const docker = run('docker', 'backend');
    assert.equal(docker.status, 1);
    assert.match(docker.stderr, /service "cache" has no Docker config/);
    assert.equal(docker.stdout, '');
    const k8s = run('k8s', 'backend');
    assert.equal(k8s.status, 1);
    assert.match(k8s.stderr, /service "cache" has no container config for Kubernetes/);
    assert.equal(k8s.stdout, '');
    // Without a typed mode, the development view of backend is still available.
    assert.equal(run('backend').status, 0);
  });

  it('checks every service for a typed mode with no service named, as up does', async () => {
    await fs.writeFile(path.join(projectDir, 'portler.yml'), `${CONFIG}  api:
    command: node api.js
    port: 5000
`, 'utf8');
    const docker = run('docker');
    assert.equal(docker.status, 1);
    assert.match(docker.stderr, /service "api" has no Docker config/);
    assert.equal(docker.stdout, '');
    const k8s = run('k8s');
    assert.equal(k8s.status, 1);
    assert.match(k8s.stderr, /service "api" has no container config for Kubernetes/);
    assert.equal(k8s.stdout, '');
    // The development view of the whole project is still available.
    assert.equal(run().status, 0);
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
