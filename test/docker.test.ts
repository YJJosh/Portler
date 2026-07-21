import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyDockerMode, normalizeDockerModeConfig, normalizeTopLevelDockerConfig } from '../src/config/docker.ts';
import { defaultDockerContainer, defaultDockerImage } from '../src/config/naming.ts';
import { dockerShellCommand } from '../src/process/docker.ts';
import type { Assignments, DockerConfig, PortlerConfig, ServiceConfig } from '../src/types/index.ts';

const PROJECT_DIR = '/project';

describe('normalizeTopLevelDockerConfig', () => {
  it('returns undefined for plain local services', () => {
    assert.equal(normalizeTopLevelDockerConfig({ command: 'npm run dev' }, 'api', PROJECT_DIR), undefined);
  });

  it('treats an image as a Docker service with default container name', () => {
    const docker = normalizeTopLevelDockerConfig({ image: 'redis:7-alpine' }, 'redis', PROJECT_DIR);
    assert.ok(docker);
    assert.equal(docker.image, 'redis:7-alpine');
    assert.equal(docker.containerName, defaultDockerContainer(PROJECT_DIR, 'redis'));
    assert.deepEqual(docker.volumes, []);
    assert.deepEqual(docker.env, {});
    assert.equal(docker.build, undefined);
  });

  it('treats volumes or type: docker as Docker services', () => {
    assert.ok(normalizeTopLevelDockerConfig({ volumes: ['./data:/data'] }, 'api', PROJECT_DIR));
    assert.ok(normalizeTopLevelDockerConfig({ type: 'docker' }, 'api', PROJECT_DIR));
  });

  it('rejects unknown type values combined with Docker keys', () => {
    assert.throws(
      () => normalizeTopLevelDockerConfig({ image: 'redis:7', type: 'vm' }, 'api', PROJECT_DIR),
      /type only supports "docker"/,
    );
    // A lone unknown type has no Docker keys, so the service stays local.
    assert.equal(normalizeTopLevelDockerConfig({ type: 'vm' }, 'api', PROJECT_DIR), undefined);
  });

  it('normalizes build objects with a default image name', () => {
    const docker = normalizeTopLevelDockerConfig(
      { build: { context: '.', dockerfile: 'apps/api/Dockerfile' } },
      'api',
      PROJECT_DIR,
    );
    assert.ok(docker);
    assert.equal(docker.image, defaultDockerImage(PROJECT_DIR, 'api'));
    assert.deepEqual(docker.build, { context: '.', dockerfile: 'apps/api/Dockerfile', target: undefined, args: {} });
  });

  it('supports a top-level dockerfile shorthand', () => {
    const docker = normalizeTopLevelDockerConfig({ dockerfile: 'Dockerfile.dev' }, 'api', PROJECT_DIR);
    assert.ok(docker?.build);
    assert.equal(docker.build.context, '.');
    assert.equal(docker.build.dockerfile, 'Dockerfile.dev');
  });

  it('supports a string build context', () => {
    const docker = normalizeTopLevelDockerConfig({ build: './backend' }, 'api', PROJECT_DIR);
    assert.equal(docker?.build?.context, './backend');
  });

  it('accepts compose-style environment and custom container_name', () => {
    const docker = normalizeTopLevelDockerConfig(
      { image: 'postgres:16', environment: { POSTGRES_USER: 'app' }, container_name: 'my-db' },
      'db',
      PROJECT_DIR,
    );
    assert.deepEqual(docker?.env, { POSTGRES_USER: 'app' });
    assert.equal(docker?.containerName, 'my-db');
  });
});

describe('normalizeDockerModeConfig', () => {
  it('returns undefined when the docker key is absent', () => {
    assert.equal(normalizeDockerModeConfig({}, 'api', PROJECT_DIR, undefined), undefined);
  });

  it('docker: true reuses the top-level config or falls back to defaults', () => {
    const topLevel = normalizeTopLevelDockerConfig({ image: 'redis:7' }, 'api', PROJECT_DIR);
    assert.equal(normalizeDockerModeConfig({ docker: true }, 'api', PROJECT_DIR, topLevel), topLevel);

    const fallback = normalizeDockerModeConfig({ docker: true }, 'api', PROJECT_DIR, undefined);
    assert.equal(fallback?.image, defaultDockerImage(PROJECT_DIR, 'api'));
    assert.equal(fallback?.containerName, defaultDockerContainer(PROJECT_DIR, 'api'));
  });

  it('docker: <string> is an image shorthand', () => {
    const docker = normalizeDockerModeConfig({ docker: 'node:22-alpine' }, 'api', PROJECT_DIR, undefined);
    assert.equal(docker?.image, 'node:22-alpine');
  });

  it('rejects invalid docker values', () => {
    assert.throws(() => normalizeDockerModeConfig({ docker: 42 }, 'api', PROJECT_DIR, undefined), /docker must be true, a string image, or an object/);
  });
});

function makeService(overrides: Partial<ServiceConfig>): ServiceConfig {
  return {
    name: 'api',
    cwd: '.',
    portEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    preferDeclaredPort: false,
    dependsOn: [],
    ...overrides,
  };
}

function makeConfig(services: Record<string, ServiceConfig>): PortlerConfig {
  return {
    filePath: `${PROJECT_DIR}/portler.yml`,
    projectDir: PROJECT_DIR,
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: PROJECT_DIR,
    volumes: [],
    k8sNamespace: 'portler-project',
    services,
  };
}

describe('applyDockerMode', () => {
  it('promotes the docker-mode override and merges its env into the service env', () => {
    const override: DockerConfig = {
      image: 'api-image',
      containerName: 'api-container',
      volumes: [],
      env: { DATABASE_URL: 'postgres://app@postgres:5432/app' },
    };
    const service = makeService({ env: { DATABASE_URL: 'local', KEEP: '1' }, dockerModeOverride: override });
    const config = applyDockerMode(makeConfig({ api: service }));

    assert.equal(config.services.api?.docker, override);
    assert.deepEqual(config.services.api?.env, { DATABASE_URL: 'postgres://app@postgres:5432/app', KEEP: '1' });
  });

  it('strips docker config from services without any Docker configuration', () => {
    const service = makeService({});
    const config = applyDockerMode(makeConfig({ api: service }));
    assert.equal(config.services.api?.docker, undefined);
  });

  it('falls back to the always-Docker config when no override exists', () => {
    const docker: DockerConfig = { image: 'redis:7', containerName: 'c', volumes: [], env: {} };
    const service = makeService({ docker });
    const config = applyDockerMode(makeConfig({ api: service }));
    assert.equal(config.services.api?.docker, docker);
  });
});

describe('dockerShellCommand', () => {
  const assignments: Assignments = {
    api: {
      name: 'api',
      port: 52001,
      host: '127.0.0.1',
      urlHost: 'localhost',
      protocol: 'http',
      url: 'http://localhost:52001',
    },
  };
  const assignment = assignments.api;

  it('generates network setup, cleanup trap, and docker run with port mapping', () => {
    const service = makeService({
      port: 5432,
      docker: { image: 'postgres:16', containerName: 'db-container', volumes: [], env: {} },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments);
    const parts = command.split(' && ');

    assert.ok(parts[0]?.startsWith('if ! net_owner=$(docker network inspect'), `expected network ownership check, got: ${parts[0]}`);
    assert.ok(parts[1]?.startsWith('if info=$(docker inspect'), `expected ownership preflight, got: ${parts[1]}`);
    assert.ok(parts[2]?.startsWith('trap '), `expected trap, got: ${parts[2]}`);
    assert.equal(
      parts[3],
      'docker run --rm --name db-container ' +
        `--label portler.project=${PROJECT_DIR} --label portler.service=api ` +
        '--network portler-net --network-alias api -p 127.0.0.1:52001:5432 postgres:16',
    );
  });

  it('refuses to use a network it does not own, before AND after a create race', () => {
    // The old snippet was `inspect || create || inspect`: a pre-existing network
    // named portler-net that belonged to someone else was silently used — and a
    // later `down` would then try to remove a stranger's network. The re-inspect
    // after a lost create race has the same hole: whoever won the race might not
    // be us.
    const service = makeService({
      port: 5432,
      docker: { image: 'postgres:16', containerName: 'db-container', volumes: [], env: {} },
    });
    const network = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments).split(' && ')[0]!;

    // Existing network: read its owner label...
    assert.ok(network.includes('docker network inspect --format'), network);
    assert.ok(network.includes('portler.project'), network);
    // ...create only when it is missing...
    assert.ok(network.includes(`docker network create --label portler.project=${PROJECT_DIR} portler-net`), network);
    // ...and re-read after the create (which may have lost a race).
    assert.ok(/net_owner=\$\(docker network inspect[^)]*\) \|\| exit 1/.test(network), network);
    // Whatever path we took, the label must match this project or we abort.
    assert.ok(network.includes(`[ "$net_owner" != ${PROJECT_DIR} ]`), network);
    assert.ok(network.includes('refusing to use it'), network);
    assert.ok(network.includes('exit 1'), network);
  });

  it('labels the container and network so removal can verify ownership', () => {
    const service = makeService({
      port: 5432,
      docker: { image: 'postgres:16', containerName: 'db-container', volumes: [], env: {} },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments);

    assert.ok(command.includes(`--label portler.project=${PROJECT_DIR}`), command);
    assert.ok(command.includes('--label portler.service=api'), command);
  });

  it('refuses to force-remove a colliding container it does not own', () => {
    const service = makeService({
      port: 5432,
      docker: { image: 'postgres:16', containerName: 'db-container', volumes: [], env: {} },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments);
    const preflight = command.split(' && ')[1]!;

    // The old code ran a bare `docker rm -f db-container`, which would destroy
    // an unrelated container that happened to hold the name.
    assert.ok(!/^docker rm -f/.test(preflight), preflight);
    assert.ok(preflight.includes('portler.project'), preflight);
    assert.ok(preflight.includes('refusing to remove it'), preflight);
    assert.ok(preflight.includes('exit 1'), preflight);
  });

  it('removes the stale container BY ID, not by its (mutable) name', () => {
    // The inspect captures .Id together with the ownership label, and the rm
    // uses that id. Removing by name would re-resolve the name afterwards: a
    // container created under that name in between would be destroyed instead,
    // even though the label we verified belonged to the old one.
    const service = makeService({
      port: 5432,
      docker: { image: 'postgres:16', containerName: 'db-container', volumes: [], env: {} },
    });
    const parts = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments).split(' && ');
    const preflight = parts[1]!;
    const trap = parts[2]!;

    assert.ok(preflight.includes('{{.Id}}'), preflight);
    assert.ok(preflight.includes('docker rm -f "$cid"'), preflight);
    assert.ok(!preflight.includes('docker rm -f db-container'), 'must not remove by name');

    // The exit trap removes our own container the same way.
    assert.ok(trap.includes('{{.Id}}'), trap);
    assert.ok(trap.includes('docker rm -f "$cid"'), trap);
    assert.ok(!trap.includes('docker rm -f db-container'), 'the trap must not remove by name either');
  });

  it('forwards only composed env keys and never inherited host PORTLER controls or internal defaults', () => {
    const service = makeService({
      port: 5432,
      docker: { image: 'img', containerName: 'c', volumes: [], env: {} },
    });
    const env = {
      PATH: '/usr/bin',
      ZED: 'z value',
      APP_KEY: 'secret',
      PORTLER_API_URL: 'http://localhost:52001',
      PORTLER_DECLARED_FLAG: 'kept',
      PORTLER_SERVICE_NAME: 'api',
      PORTLER_GLOBAL_DIR: '/host/private/.portler',
      PORTLER_HOME: '/host/private/portler-home',
      PORTLER_ALLOW_K8S_CONTEXT: 'private-context',
      PORTLER_ALLOW_K8S_ENDPOINT: 'https://cluster.example:6443',
      PORTLER_INHERITED_SECRET: 'must-not-leak',
      pnpm_config_verify_deps_before_run: 'false',
    };
    const explicitKeys = new Set([
      'APP_KEY',
      'PORTLER_API_URL',
      'PORTLER_DECLARED_FLAG',
      'PORTLER_SERVICE_NAME',
      'ZED',
      // buildServiceEnv adds this internal default to explicitKeys; the final
      // container boundary must still filter it.
      'pnpm_config_verify_deps_before_run',
    ]);
    const command = dockerShellCommand(makeConfig({ api: service }), service, env, explicitKeys, assignment, assignments);

    for (const inheritedKey of [
      'PATH',
      'PORTLER_GLOBAL_DIR',
      'PORTLER_HOME',
      'PORTLER_ALLOW_K8S_CONTEXT',
      'PORTLER_ALLOW_K8S_ENDPOINT',
      'PORTLER_INHERITED_SECRET',
      'pnpm_config_verify_deps_before_run',
    ]) {
      assert.ok(!command.includes(`${inheritedKey}=`), `${inheritedKey} must not be forwarded`);
    }

    const run = command.split(' && ').at(-1)!;
    assert.ok(
      run.includes(
        "-e APP_KEY=secret -e PORTLER_API_URL=http://localhost:52001 -e PORTLER_DECLARED_FLAG=kept " +
          "-e PORTLER_SERVICE_NAME=api -e 'ZED=z value'",
      ),
      run,
    );
  });

  it('verifies managed-volume ownership after create so a foreign race winner is never mounted', () => {
    const service = makeService({
      docker: { image: 'img', containerName: 'c', volumes: ['@pgdata:/data'], env: {} },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), undefined, assignments);
    const volumeCheck = command.split(' && ')[1]!;

    assert.match(volumeCheck, /docker volume inspect --format/);
    assert.match(volumeCheck, /docker volume create --label portler\.project=/);
    assert.match(volumeCheck, /volume_owner=\$\(docker volume inspect/);
    assert.match(volumeCheck, /\[ "\$volume_owner" != \/project \]/);
    assert.match(volumeCheck, /refusing to mount it/);
    assert.match(volumeCheck, /exit 1/);
  });

  it('shell-quotes user-controlled names even in diagnostic branches', () => {
    const injection = 'bad$(touch /tmp/portler-should-not-run)';
    const service = makeService({
      docker: { image: 'img', containerName: injection, volumes: [], env: {} },
    });
    const config = { ...makeConfig({ api: service }), dockerNetwork: injection };
    const command = dockerShellCommand(config, service, {}, new Set(), undefined, assignments);

    assert.doesNotMatch(command, /echo "[^"\n]*\$\(/, 'command substitution must never appear inside a double-quoted diagnostic');
    assert.match(command, /printf '%s\\n' '[^']*\$\(touch/);
  });

  it('normalizes relative and @-named volumes', () => {
    const service = makeService({
      docker: {
        image: 'img',
        containerName: 'c',
        volumes: ['./data:/data', '@pgdata:/var/lib/postgresql/data', 'named:/plain'],
        env: {},
      },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), undefined, assignments);

    assert.ok(command.includes(`-v ${PROJECT_DIR}/data:/data`), command);
    assert.ok(command.includes(`-v ${defaultDockerImage(PROJECT_DIR, 'pgdata')}:/var/lib/postgresql/data`), command);
    assert.ok(command.includes('-v named:/plain'), command);
  });

  it('rejects @ volumes without a name', () => {
    const service = makeService({
      docker: { image: 'img', containerName: 'c', volumes: ['@:/data'], env: {} },
    });
    assert.throws(
      () => dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), undefined, assignments),
      /@ shorthand requires a name/,
    );
  });

  it('prepends a docker build command and resolves build args', () => {
    const service = makeService({
      docker: {
        image: 'api-img',
        containerName: 'c',
        volumes: [],
        env: {},
        build: { context: '.', dockerfile: 'apps/api/Dockerfile', args: { API_PORT: 'api.port' } },
      },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), undefined, assignments);
    const build = command.split(' && ')[0];

    assert.equal(
      build,
      `docker build -t api-img -f ${PROJECT_DIR}/apps/api/Dockerfile --build-arg API_PORT=52001 ${PROJECT_DIR}`,
    );
  });

  it('runs a custom container command via sh -lc', () => {
    const service = makeService({
      docker: { image: 'img', containerName: 'c', volumes: [], env: {}, command: 'npm run start' },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), undefined, assignments);
    assert.ok(command.endsWith("img sh -lc 'npm run start'"), command);
  });

  it('omits the port mapping when the service declares no port', () => {
    const service = makeService({
      docker: { image: 'img', containerName: 'c', volumes: [], env: {} },
    });
    const command = dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments);
    assert.ok(!command.includes('-p '), command);
  });

  it('throws for non-Docker services', () => {
    const service = makeService({});
    assert.throws(
      () => dockerShellCommand(makeConfig({ api: service }), service, {}, new Set(), assignment, assignments),
      /is not a Docker service/,
    );
  });
});
