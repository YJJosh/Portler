/**
 * Command-level tests. These run real CLI command functions against a temp
 * project directory; none of them start services, touch Docker, or touch a
 * cluster.
 */
import assert from 'node:assert/strict';
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
import { readRegistry, writeRegistry } from '../src/ports/registry.ts';
import { writePids } from '../src/process/pids.ts';
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
    await assert.rejects(main(['ports', 'api']), /ports does not accept positional arguments/);
    await assert.rejects(main(['init', 'extra']), /init does not accept positional arguments/);
    await assert.rejects(main(['volumes', 'list', '--force']), /--force only applies to "portler volumes remove"/);
    await assert.rejects(commandClean(parseArgs(['--global', '--file', 'other.yml'], 'clean')), /--file does not apply/);
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
