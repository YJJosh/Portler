/**
 * Command-level tests. These run real CLI command functions against a temp
 * project directory; none of them start services, touch Docker, or touch a
 * cluster.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { main } from '../src/cli/index.ts';
import { commandClean } from '../src/cli/commands/clean.ts';
import { commandRestart } from '../src/cli/commands/restart.ts';
import { commandDown } from '../src/cli/commands/down.ts';
import { commandUp } from '../src/cli/commands/up.ts';
import { forkUpCommand } from '../src/cli/commands/volumes.ts';
import { readRegistry, writeRegistry } from '../src/ports/registry.ts';
import { readPids, writePids } from '../src/process/pids.ts';
import { pathExists } from '../src/util/fs.ts';
import { CorruptStateFileError } from '../src/util/json-file.ts';

const CONFIG = ['services:', '  api:', '    command: node -e ""', '    port: 3000'].join('\n');

let projectDir: string;
let previousCwd: string;
let previousGlobalDir: string | undefined;
let globalDir: string;

beforeEach(async () => {
  previousCwd = process.cwd();
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;

  projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-cmd-')));
  globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-global-'));
  process.env.PORTLER_GLOBAL_DIR = globalDir;

  await fs.writeFile(path.join(projectDir, 'portler.yml'), CONFIG, 'utf8');
  process.chdir(projectDir);
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
  else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;

  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(globalDir, { recursive: true, force: true });
});

async function writeCorruptPids(): Promise<string> {
  const pidsPath = path.join(projectDir, '.portler', 'pids.json');
  await fs.mkdir(path.dirname(pidsPath), { recursive: true });
  await fs.writeFile(pidsPath, '{ truncated mid-writ', 'utf8');
  return pidsPath;
}

describe('CLI command contracts', () => {
  it('rejects flags and positional arguments a command would otherwise silently ignore', async () => {
    await assert.rejects(main(['ports', '--force']), /--force does not apply to "portler ports"/);
    await assert.rejects(main(['down', '--image', 'api=img']), /--image does not apply to "portler down"/);
    await assert.rejects(main(['ports', 'api']), /ports does not accept positional arguments/);
    await assert.rejects(main(['init', 'extra']), /init does not accept positional arguments/);
    await assert.rejects(main(['volumes', 'list', '--force']), /--force only applies to "portler volumes remove"/);
    await assert.rejects(commandClean(parseArgs(['--global', '--file', 'other.yml'], 'clean')), /--file does not apply/);
  });

  it('suggests an up command that runs in the same scope as the fork', () => {
    assert.equal(forkUpCommand('migration', parseArgs(['volumes', 'fork', 'data', 'migration'])), 'portler up --volume-set migration');
    assert.equal(forkUpCommand('migration', parseArgs(['volumes', 'fork', 'data', 'migration', '--prod'])), 'portler up --prod --volume-set migration');
    assert.equal(
      forkUpCommand('migration', parseArgs(['volumes', 'fork', 'data', 'migration', '--prod', '--file', 'deploy/portler prod.yml'])),
      "portler up --file 'deploy/portler prod.yml' --prod --volume-set migration",
    );
  });

  it('rejects --image for a service the command does not start', async () => {
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  web:', '    image: example/web', '  api:', '    command: node -e ""', '    port: 3000', ''].join('\n'),
      'utf8',
    );

    // web is a Docker service, so the override itself is valid; it is just not part of `up api`.
    await assert.rejects(
      commandUp(parseArgs(['api', '--image', 'web=example/web@sha256:abc'], 'up')),
      /--image: service "web" is not started by this command/,
    );
    assert.equal(await pathExists(path.join(projectDir, '.portler', 'state.json')), false);
  });

  it('rejects a Docker-only volume set in Kubernetes mode before touching a cluster', async () => {
    await assert.rejects(commandUp(parseArgs(['k8s', '--volume-set', 'branch'], 'up')), /applies to Docker volumes/);
  });

  it('rejects duplicate Docker container names before allocating or starting anything', async () => {
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      [
        'services:',
        '  one:',
        '    image: example/one',
        '    container_name: shared',
        '  two:',
        '    image: example/two',
        '    container_name: shared',
        '',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(commandUp(parseArgs([], 'up')), /both use Docker container name "shared"/);
    assert.equal(await pathExists(path.join(projectDir, '.portler', 'state.json')), false);
  });
});

describe('up startup liveness', () => {
  it('fails when a member of an earlier level dies while a later level is still starting', async () => {
    // db passes its check, then dies while api (which depends on it) is still
    // coming up. api's own wait knows nothing about db, so without the scan
    // after each level `up -d` would report a started stack with a dead db.
    await fs.writeFile(
      path.join(projectDir, 'db.js'),
      "require('net').createServer().listen(process.env.PORT, '127.0.0.1'); setTimeout(() => process.exit(1), 1500);\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, 'api.js'),
      "setTimeout(() => require('net').createServer().listen(process.env.PORT, '127.0.0.1'), 2500); setInterval(() => {}, 1000);\n",
      'utf8',
    );
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      [
        'services:',
        '  db:',
        '    command: node db.js',
        '    port: 3001',
        '    port_env: PORT',
        '  api:',
        '    command: node api.js',
        '    port: 3000',
        '    port_env: PORT',
        '    depends_on: [db]',
      ].join('\n'),
      'utf8',
    );
    await assert.rejects(
      commandUp(parseArgs(['-d'], 'up')),
      /service db exited while the stack was still starting\. Check .*db\.log \(or "portler logs db"\) for the cause, then run the same command again/,
    );
    const pids = await readPids(projectDir);
    assert.ok(pids === null || !Object.hasOwn(pids.services, 'api'), 'the rollback stopped api');
  });

  it('sees a dependency the restart leaves running die while the restarted service starts', async () => {
    // `restart api` leaves a running db untouched (skipRunning), so db is not
    // among the children this run spawned. If db dies while api is still coming
    // up, the scan has to see it through db's recorded pid.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await fs.writeFile(
        path.join(projectDir, 'api.js'),
        "setTimeout(() => require('net').createServer().listen(process.env.PORT, '127.0.0.1'), 2000); setInterval(() => {}, 1000);\n",
        'utf8',
      );
      await fs.writeFile(
        path.join(projectDir, 'portler.yml'),
        [
          'services:',
          '  db:',
          '    command: node -e ""',
          '    port: 3001',
          '  api:',
          '    command: node api.js',
          '    port: 3000',
          '    port_env: PORT',
          '    depends_on: [db]',
        ].join('\n'),
        'utf8',
      );
      const startedAt = new Date().toISOString();
      await writePids(projectDir, {
        version: 1,
        project: projectDir,
        startedAt,
        services: { db: { pid: sleeper.pid!, command: 'db', cwd: projectDir, port: 3001, startedAt } },
      });
      setTimeout(() => sleeper.kill(), 700);
      await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /service db exited while the stack was still starting/);
      const pids = await readPids(projectDir);
      assert.ok(!pids?.services.api, 'the rollback stopped api');
    } finally {
      sleeper.kill();
    }
  });
});

describe('restart', () => {
  it('rejects Kubernetes mode instead of silently running services locally', async () => {
    // The bug: `restart k8s` applied the k8s config overlay (in-cluster DNS
    // hostnames, k8s.env) and then spawned the services as LOCAL processes,
    // because only `up` routes k8s mode to commandUpK8s. Nothing ever reached
    // the cluster, and the services came up with in-cluster env values.
    await assert.rejects(
      commandRestart(parseArgs(['k8s'], 'restart')),
      /restart does not support Kubernetes mode/,
    );
  });

  it('refuses a plain restart of a service started with --prod, before stopping anything', async () => {
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      // Live pid, no token: if restart gets past the guard it must refuse to stop this entry.
      services: { api: { pid: process.pid, command: 'test runner', cwd: projectDir, port: 52345, prod: true, startedAt } },
    });

    await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /api was started with --prod/);
    await assert.rejects(commandRestart(parseArgs([], 'restart')), /api was started with --prod/);
    assert.ok((await readPids(projectDir))?.services.api, 'nothing was stopped');

    // With the flag the guard passes and restart reaches the stop step, which refuses
    // the unverified entry. Going through main proves the scope check accepts --prod.
    await assert.rejects(main(['restart', 'api', '--prod']), /restart could not stop/);
  });

  it('accepts --setup and --no-setup on restart, like up', async () => {
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: { api: { pid: process.pid, command: 'test runner', cwd: projectDir, port: 52345, prod: false, startedAt } },
    });
    // The scope check accepts both flags; restart then reaches the stop step, which refuses the unverified entry.
    await assert.rejects(main(['restart', 'api', '--no-setup']), /restart could not stop/);
    await assert.rejects(main(['restart', 'api', '--setup']), /restart could not stop/);
  });

  it('refuses a plain restart of a service running in Docker, and restart docker of a local process', async () => {
    // api runs as a local process under plain `up` and as a container under `up docker`.
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  api:', '    command: node -e ""', '    port: 3000', '    docker:', '      image: node:22-alpine'].join('\n'),
      'utf8',
    );
    const startedAt = new Date().toISOString();
    const seed = (dockerContainer?: string) =>
      writePids(projectDir, {
        version: 1,
        project: projectDir,
        startedAt,
        services: {
          api: { pid: process.pid, command: 'test runner', cwd: projectDir, port: 52345, prod: false, startedAt, ...(dockerContainer ? { dockerContainer } : {}) },
        },
      });

    await seed('portler-test-api');
    await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /api is running in Docker[^]*restart docker api/);
    assert.ok((await readPids(projectDir))?.services.api, 'nothing was stopped');
    // With `docker` the guard passes and restart reaches the stop step, which refuses the unverified entry.
    await assert.rejects(commandRestart(parseArgs(['docker', 'api'], 'restart')), (error: Error) => !/running in Docker/.test(error.message));

    await seed(undefined);
    await assert.rejects(commandRestart(parseArgs(['docker', 'api'], 'restart')), /api is running as a local process[^]*without "docker"/);
    assert.ok((await readPids(projectDir))?.services.api, 'nothing was stopped');
  });

  it('does not mistake an Object.prototype member for a recorded service', async () => {
    // With no pids.json, `running` is an empty object, and `running.constructor` is still Object.
    // The guard must not report a service named constructor as a running development service.
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  constructor:', '    command: node -e ""', '    port: 3000'].join('\n'),
      'utf8',
    );
    // The guard passes and restart goes on to start the service, whose command exits at once.
    await assert.rejects(commandRestart(parseArgs(['constructor', '--prod'], 'restart')), (error: Error) => !/development mode/.test(error.message));
  });

  it('refuses restart --prod of a service running in development mode, before stopping anything', async () => {
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      // Live pid, no token: if restart gets past the guard it must refuse to stop this entry.
      services: { api: { pid: process.pid, command: 'test runner', cwd: projectDir, port: 52345, prod: false, startedAt } },
    });

    await assert.rejects(commandRestart(parseArgs(['api', '--prod'], 'restart')), /api was started in development mode/);
    await assert.rejects(commandRestart(parseArgs(['--prod'], 'restart')), /api was started in development mode/);
    assert.ok((await readPids(projectDir))?.services.api, 'nothing was stopped');

    // Same mode: the guard passes and restart reaches the stop step, which refuses the unverified entry.
    await assert.rejects(commandRestart(parseArgs(['api'], 'restart')), /restart could not stop/);
  });

  it('rejects --image for a dependency the restart leaves running, before stopping anything', async () => {
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  db:', '    image: example/db', '  api:', '    command: node -e ""', '    port: 3000', '    depends_on: db', ''].join('\n'),
      'utf8',
    );
    const startedAt = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt,
      services: {
        // db is alive (this process stands in for it) and not named, so `restart api` leaves it running.
        // A top-level `image:` service always runs in Docker, so its entry carries the container name.
        db: { pid: process.pid, command: 'db', cwd: projectDir, startedAt, dockerContainer: 'portler-test-db' },
        // api is a stale entry; a restart that got as far as stopping would have pruned it.
        api: { pid: 4_194_303, command: 'api', cwd: projectDir, startedAt },
      },
    });

    await assert.rejects(
      commandRestart(parseArgs(['api', '--image', 'db=example/db@sha256:abc'], 'restart')),
      /--image: service "db" is already running and this command leaves it running/,
    );
    const pids = await readPids(projectDir);
    assert.ok(pids?.services.api, 'the rejection came before the stop: the stale api entry is still there');
  });

  it('points the user at the down/up sequence that does work', async () => {
    await assert.rejects(commandRestart(parseArgs(['k8s'], 'restart')), /portler down k8s.*portler up k8s/s);
  });
});

describe('clean', () => {
  it('reports a corrupt PID file with an actionable message', async () => {
    await writeCorruptPids();

    await assert.rejects(commandClean(parseArgs([], 'clean')), (error: unknown) => {
      assert.ok(error instanceof CorruptStateFileError);
      assert.match((error as Error).message, /portler clean --force/);
      return true;
    });
  });

  it('recovers from a corrupt PID file with --force', async () => {
    // Without this, `clean --force` — the documented way to fix broken state —
    // died on the very file it exists to delete.
    await writeCorruptPids();

    const exitCode = await commandClean(parseArgs(['--force'], 'clean'));

    assert.equal(exitCode, 0);
    assert.equal(await pathExists(path.join(projectDir, '.portler')), false, '.portler/ should be gone');
  });

  it('leaves .portler in place for --ports', async () => {
    await fs.mkdir(path.join(projectDir, '.portler'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.portler', 'state.json'), '{}', 'utf8');

    const exitCode = await commandClean(parseArgs(['--ports'], 'clean'));

    assert.equal(exitCode, 0);
    assert.equal(await pathExists(path.join(projectDir, '.portler')), true);
  });

  it('rejects service names', async () => {
    await assert.rejects(commandClean(parseArgs(['api'], 'clean')), /clean does not accept service names/);
  });

  it('cleans stale PID entries before deleting the only resource bookkeeping', async () => {
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: new Date().toISOString(),
      services: {
        old: { pid: 4_194_303, command: 'old', cwd: projectDir, startedAt: new Date().toISOString() },
      },
    });

    assert.equal(await commandClean(parseArgs([], 'clean')), 0);
    assert.equal(await pathExists(path.join(projectDir, '.portler')), false);
  });

  it('resets a corrupt global registry only with the explicit --global --force recovery', async () => {
    await fs.writeFile(path.join(globalDir, 'ports.json'), '{truncated', 'utf8');
    await assert.rejects(commandClean(parseArgs(['--global'], 'clean')), /--global --force/);

    assert.equal(await commandClean(parseArgs(['--global', '--force'], 'clean')), 0);
    assert.deepEqual(await readRegistry(), { version: 1, ports: {} });
  });
});

describe('down port release safety', () => {
  it('keeps the reservation of a live process whose identity was not verified', async () => {
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: new Date().toISOString(),
      services: {
        api: {
          pid: process.pid,
          command: 'test runner',
          cwd: projectDir,
          port: 52345,
          startedAt: new Date().toISOString(),
          // No token: ordinary down must refuse to signal it.
        },
      },
    });
    await writeRegistry({
      version: 1,
      ports: {
        '52345': {
          project: projectDir,
          service: 'api',
          port: 52345,
          host: '127.0.0.1',
          assignedAt: new Date().toISOString(),
        },
      },
    });

    assert.equal(await commandDown(parseArgs([], 'down')), 1);
    assert.equal((await readRegistry()).ports['52345']?.service, 'api');
  });
});
