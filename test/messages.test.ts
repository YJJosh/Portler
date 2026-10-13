import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { recordedVolumeSet, recoveryCommand, upSuggestion } from '../src/cli/commands/down.ts';
import { restartSuggestion } from '../src/cli/commands/up.ts';
import { ensureNoOverlap } from '../src/cli/services.ts';
import { assertRequiredEnv } from '../src/env/index.ts';
import { readPids, readProcessStartToken, writePids } from '../src/process/index.ts';
import type { PidServiceInfo, ServiceConfig } from '../src/types/index.ts';
import { projectHash } from '../src/util/hash.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const projects: string[] = [];

afterEach(async () => {
  for (const projectDir of projects.splice(0)) {
    portler(projectDir, 'down');
    await fs.rm(path.dirname(projectDir), { recursive: true, force: true });
  }
});

async function project(yaml: string, files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-messages-')));
  const projectDir = path.join(dir, 'app');
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, 'portler.yml'), yaml);
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(projectDir, name), content);
  projects.push(projectDir);
  return projectDir;
}

function portler(projectDir: string, ...args: string[]) {
  return portlerWith(projectDir, {}, ...args);
}

function portlerWith(projectDir: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORTLER_GLOBAL_DIR: path.join(path.dirname(projectDir), 'global'), ...extraEnv };
  delete env.PORT;
  delete env.PUBLIC_URL;
  delete env.ADMIN_TOKEN;
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], { cwd: projectDir, env, encoding: 'utf8' });
}

const server = "require('http').createServer((_, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n";

describe('a missing production key', () => {
  it('names the prod.env line that left it blank, not prod.require', () => {
    assert.throws(() => assertRequiredEnv('service web', ['PUBLIC_URL'], {}, new Set(['PUBLIC_URL'])), /requires PUBLIC_URL in production \(left blank in prod\.env\)/);
    assert.throws(() => assertRequiredEnv('service web', ['ADMIN_TOKEN'], {}, new Set()), /requires ADMIN_TOKEN in production \(prod\.require\)/);
    assert.throws(
      () => assertRequiredEnv('service web', ['ADMIN_TOKEN', 'PUBLIC_URL'], {}, new Set(['PUBLIC_URL'])),
      /requires ADMIN_TOKEN, PUBLIC_URL in production \(prod\.require: ADMIN_TOKEN; left blank in prod\.env: PUBLIC_URL\)/,
    );
  });

  it('says startup failed before anything started, not that it is stopping started services', async () => {
    const projectDir = await project(
      ['services:', '  web:', '    command: node server.js', '    port: 4000', '    port_env: PORT', '    prod:', '      env:', '        PUBLIC_URL:', ''].join('\n'),
      { 'server.js': server },
    );
    const result = portler(projectDir, 'up', '--prod', '-d');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /service web requires PUBLIC_URL in production \(left blank in prod\.env\)/);
    assert.match(result.stderr, /startup failed before any service started/);
    assert.doesNotMatch(result.stderr, /stopping already-started services/);
  });
});

describe('up for a service that is partly running', () => {
  it('suggests restart before down', () => {
    assert.throws(
      () => ensureNoOverlap(new Set(['redis']), ['redis', 'worker'], 'portler restart worker'),
      /^Error: already running: redis\. To \(re\)start services next to what is running, use "portler restart worker"; to start over, use "portler down redis" first\.$/,
    );
    // Without an alternative (Kubernetes mode, which restart does not cover) only down is offered.
    assert.throws(() => ensureNoOverlap(new Set(['redis']), ['redis'], undefined), /^Error: already running: redis\. Use "portler down redis" first\.$/);
  });

  it('builds the suggested restart from the refused invocation', () => {
    assert.equal(restartSuggestion({}, 'local', ['worker']), 'portler restart worker');
    // A service with no PID entry has nothing for restart to replay, so the pin, the mode,
    // the config file and the volume set must travel in the command itself.
    assert.equal(
      restartSuggestion(
        { file: 'deploy/portler.yml', prod: true, setup: false, images: { worker: 'registry/worker@sha256:abc' }, volumeSet: 'feat x' },
        'docker',
        ['worker'],
      ),
      "portler restart docker worker --file deploy/portler.yml --prod --no-setup --image worker=registry/worker@sha256:abc --volume-set 'feat x'",
    );
  });

  it('suggests only down when a running prerequisite was started in another mode', async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4230',
        '    port_env: PORT',
        '    docker:',
        '      image: postgres:16-alpine',
        '  api:',
        '    command: node server.js',
        '    port: 4231',
        '    port_env: PORT',
        '    depends_on: [db]',
        '    docker:',
        '      image: example/api:latest',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d', 'db').status, 0);

    // restart docker would refuse to mix modes, and a plain restart would start api locally.
    const refused = portler(projectDir, 'up', 'docker', '-d', 'api');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /already running: db\. Use "portler down db" first\./);
    assert.doesNotMatch(refused.stderr, /portler restart/);
  });

  it('suggests only down when a pinned image is for a service restart would leave running', { timeout: 20_000 }, async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shell script as docker');
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    docker:',
        '      image: postgres:16-alpine',
        '  api:',
        '    docker:',
        '      image: example/api:latest',
        '    depends_on: [db]',
        '',
      ].join('\n'),
    );
    const bin = path.join(path.dirname(projectDir), 'bin');
    await fs.mkdir(bin);
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': projectDir }, running: true });
    await fs.writeFile(
      path.join(bin, 'docker'),
      ['#!/bin/sh', 'case "$1" in', `  inspect) printf '%s\\n' '${inspected}' ;;`, '  *) echo "Error: No such object" >&2; exit 1 ;;', 'esac', ''].join('\n'),
      { mode: 0o755 },
    );
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
    // db's container runs on after its `docker run` shell has exited: running, as ps reports it.
    const shell = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => shell.once('exit', resolve));
    const now = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: now,
      services: { db: { pid: shell.pid!, command: 'docker run', cwd: projectDir, startedAt: now, runMode: 'docker', dockerContainer: 'c-db' } },
    });

    const refused = portlerWith(projectDir, env, 'up', 'docker', '-d', 'api', '--image', 'db=postgres:17-alpine');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /already running: db\. Use "portler down db" first\./);
    assert.doesNotMatch(refused.stderr, /portler restart/);
    // The restart the message used to offer refuses the pin: it would leave db on its old image.
    const restart = portlerWith(projectDir, env, 'restart', 'docker', 'api', '--image', 'db=postgres:17-alpine');
    assert.notEqual(restart.status, 0, restart.stdout + restart.stderr);
    assert.match(restart.stderr, /db/);

    // Without the pin, restart would do what was asked, and is offered.
    const plain = portlerWith(projectDir, env, 'up', 'docker', '-d', 'api');
    assert.equal(plain.status, 1, plain.stdout + plain.stderr);
    assert.match(plain.stderr, /use "portler restart docker api"; to start over, use "portler down db" first\./);
  });

  it("suggests only down when the requested service's stale entry was started with --prod", async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4220',
        '    port_env: PORT',
        '  api:',
        '    command: node server.js',
        '    port: 4221',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d', 'db').status, 0);
    // api's entry outlived it: recorded under --prod, its process long gone.
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => gone.once('exit', resolve));
    const pids = (await readPids(projectDir))!;
    pids.services.api = {
      pid: gone.pid!,
      command: 'node server.js',
      cwd: projectDir,
      startedAt: new Date().toISOString(),
      runMode: 'local',
      prod: true,
      dependsOn: ['db'],
    };
    await writePids(projectDir, pids);

    const refused = portler(projectDir, 'up', '-d', 'api');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /already running: db\. Use "portler down db" first\./);
    assert.doesNotMatch(refused.stderr, /portler restart/);
    // The restart the message used to offer goes by api's entry, not by this command.
    const restart = portler(projectDir, 'restart', 'api');
    assert.notEqual(restart.status, 0, restart.stdout + restart.stderr);
    assert.doesNotMatch(portler(projectDir, 'ps').stdout, /^api\s.*running/m);
  });

  it('suggests only down when a running prerequisite was started without --prod', async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4210',
        '    port_env: PORT',
        '  api:',
        '    command: node server.js',
        '    port: 4211',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d', 'db').status, 0);

    const refused = portler(projectDir, 'up', '-d', '--prod', 'api');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /already running: db\. Use "portler down db" first\./);
    assert.doesNotMatch(refused.stderr, /portler restart/);

    // The restart the old message offered is refused too, and nothing was started.
    const restart = portler(projectDir, 'restart', 'api', '--prod');
    assert.notEqual(restart.status, 0, restart.stdout + restart.stderr);
    assert.doesNotMatch(portler(projectDir, 'ps').stdout, /^api\s/m);
  });

  it('names only what is not running, keeps the options, and the suggestion works', async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4200',
        '    port_env: PORT',
        '  api:',
        '    command: node server.js',
        '    port: 4201',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d', 'db').status, 0);

    // Foreground: refused before anything starts, and told restart runs in the background.
    const refused = portler(projectDir, 'up', '--file', 'portler.yml', '--no-setup', 'api');
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(
      refused.stderr,
      /use "portler restart api --file portler\.yml --no-setup" \(restart starts them in the background\); to start over, use "portler down db" first\./,
    );

    // Everything requested: the suggestion names api only, since restarting db would stop it.
    const all = portler(projectDir, 'up', '-d');
    assert.equal(all.status, 1, all.stdout + all.stderr);
    assert.match(all.stderr, /use "portler restart api"; to start over/);

    // Run exactly what the refusal suggested.
    const restart = portler(projectDir, 'restart', 'api', '--file', 'portler.yml', '--no-setup');
    assert.equal(restart.status, 0, restart.stdout + restart.stderr);
    assert.match(portler(projectDir, 'ps').stdout, /^api\s.*running/m);
  });
});

describe('down for one service', () => {
  it('warns about running services that depend on it', async () => {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    command: node server.js',
        '    port: 4100',
        '    port_env: PORT',
        '  api:',
        '    command: node server.js',
        '    port: 4101',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    const up = portler(projectDir, 'up', '-d');
    assert.equal(up.status, 0, up.stdout + up.stderr);

    const down = portler(projectDir, 'down', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /stopped: db/);
    assert.match(down.stderr, /warning: still running and depending on what was stopped: api \(on db\)\. Stop them too, or bring it back with "portler up -d db"\./);

    // Stopping the dependent itself warns about nothing.
    const downApi = portler(projectDir, 'down', 'api');
    assert.equal(downApi.status, 0, downApi.stdout + downApi.stderr);
    assert.doesNotMatch(downApi.stderr, /warning/);
  });
});

function entry(fields: Partial<PidServiceInfo>): PidServiceInfo {
  return { pid: 1, command: 'x', cwd: '/', startedAt: new Date(0).toISOString(), ...fields };
}

describe('the up a dependents warning suggests', () => {
  it('starts the services again the way they were started', () => {
    assert.equal(upSuggestion(['db'], [entry({ runMode: 'local' })], 'local', undefined), 'portler up -d db');
    assert.equal(
      upSuggestion(['db'], [entry({ runMode: 'docker', prod: true, setup: false, image: 'registry/pg@sha256:abc' })], 'local', 'deploy/portler.yml'),
      'portler up docker -d db --file deploy/portler.yml --prod --no-setup --image db=registry/pg@sha256:abc',
    );
    // An older entry records no mode: the mode down ran in stands in for it.
    assert.equal(upSuggestion(['db'], [entry({})], 'docker', undefined), 'portler up docker -d db');
    // Kubernetes entries record no --image pin (a portless service has no entry at all), so
    // a bare up k8s could deploy another image than the one that ran: no command.
    assert.equal(upSuggestion(['db'], [undefined], 'k8s', undefined), undefined);
    assert.equal(upSuggestion(['db'], [entry({ runMode: 'k8s' })], 'local', undefined), undefined);
  });

  it('offers no single command for services started in different ways', () => {
    assert.equal(upSuggestion(['db', 'cache'], [entry({ runMode: 'docker' }), entry({ runMode: 'local' })], 'local', undefined), undefined);
    assert.equal(upSuggestion(['db', 'cache'], [entry({ prod: true }), entry({})], 'local', undefined), undefined);
  });

  it('repeats the volume set the services were on, and only when it can', () => {
    const docker = entry({ runMode: 'docker', dockerContainer: 'c-db' });
    assert.equal(upSuggestion(['db'], [docker], 'local', undefined, ['branch'], undefined), 'portler up docker -d db --volume-set branch');
    assert.equal(upSuggestion(['db'], [docker], 'local', undefined, [''], undefined), 'portler up docker -d db');
    // No @ volume, no say.
    assert.equal(upSuggestion(['db', 'cache'], [docker, docker], 'local', undefined, ['branch', undefined], undefined), 'portler up docker -d db cache --volume-set branch');
    // Different sets, or an entry that cannot say which: no single up brings them back.
    assert.equal(upSuggestion(['db', 'cache'], [docker, docker], 'local', undefined, ['branch', ''], undefined), undefined);
    assert.equal(upSuggestion(['db'], [docker], 'local', undefined, [null], undefined), undefined);
    // Base volumes cannot be asked for by flag, so PORTLER_VOLUME_SET would make a plain up pick another set.
    assert.equal(upSuggestion(['db'], [docker], 'local', undefined, [''], 'branch'), undefined);
    // A set on the command line wins over the variable.
    assert.equal(upSuggestion(['db'], [docker], 'local', undefined, ['branch'], 'other'), 'portler up docker -d db --volume-set branch');
  });

  it('restarts instead when a prerequisite still runs, and only when restart would accept it', () => {
    const docker = entry({ runMode: 'docker', dockerContainer: 'c-db', prod: true });
    const cache = entry({ runMode: 'docker', dockerContainer: 'c-cache', prod: true });
    assert.equal(
      recoveryCommand(['db'], [docker], 'local', 'deploy/portler.yml', ['branch'], [cache], undefined),
      "portler restart docker db --file deploy/portler.yml --prod --volume-set branch",
    );
    assert.equal(recoveryCommand(['db'], [entry({ runMode: 'local' })], 'local', undefined, [], [entry({ runMode: 'local' })], undefined), 'portler restart db');
    // Nothing still running: up, as before.
    assert.equal(recoveryCommand(['db'], [docker], 'local', undefined, [''], [], undefined), 'portler up docker -d db --prod');
    // restart would refuse a prerequisite started another way, or one whose mode is not recorded.
    assert.equal(recoveryCommand(['db'], [docker], 'local', undefined, [''], [entry({ runMode: 'docker' })], undefined), undefined);
    assert.equal(recoveryCommand(['db'], [docker], 'local', undefined, [''], [entry({ runMode: 'local', prod: true })], undefined), undefined);
    assert.equal(recoveryCommand(['db'], [docker], 'local', undefined, [''], [entry({ prod: true })], undefined), undefined);
    // Kubernetes has no restart.
    assert.equal(recoveryCommand(['db'], [undefined], 'k8s', undefined, [], [entry({ runMode: 'k8s' })], undefined), undefined);
  });

  it('reads the volume set from the entry, or says when an older entry cannot tell', () => {
    const service = (volumes: string[]): ServiceConfig =>
      ({ dependsOn: [], env: {}, docker: { image: 'postgres:16-alpine', volumes } }) as unknown as ServiceConfig;
    assert.equal(recordedVolumeSet(service(['@data:/data']), entry({ runMode: 'local', dockerContainer: 'c', volumeSet: 'branch' })), 'branch');
    assert.equal(recordedVolumeSet(service(['@data:/data']), entry({ runMode: 'local', dockerContainer: 'c', volumeSet: '' })), '');
    // Written before entries recorded the set, by a container that mounts an @ volume: unknown.
    assert.equal(recordedVolumeSet(service(['@data:/data']), entry({ runMode: 'local', dockerContainer: 'c' })), null);
    // No @ volume in the mode it ran in, or no container at all: the set does not matter.
    assert.equal(recordedVolumeSet(service(['./data:/data']), entry({ runMode: 'local', dockerContainer: 'c' })), undefined);
    assert.equal(recordedVolumeSet(service(['@data:/data']), entry({ runMode: 'local' })), undefined);
    assert.equal(recordedVolumeSet(service(['@data:/data']), undefined), undefined);
  });
});

describe('down warns from what is running, not from an edited portler.yml', () => {
  it('warns when down removes a running container whose entry it has to keep', { timeout: 20_000 }, async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shell script as docker');
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    docker:',
        '      image: postgres:16-alpine',
        '  api:',
        '    command: node -e "setInterval(() => {}, 1000)"',
        '    depends_on: [db]',
        '',
      ].join('\n'),
    );
    const bin = path.join(path.dirname(projectDir), 'bin');
    await fs.mkdir(bin);
    const inspected = JSON.stringify({ id: 'sha256:c', labels: { 'portler.project': projectDir }, running: true });
    await fs.writeFile(
      path.join(bin, 'docker'),
      ['#!/bin/sh', 'case "$1" in', '  rm) exit 0 ;;', `  inspect) printf '%s\\n' '${inspected}' ;;`, '  *) echo "Error: No such object" >&2; exit 1 ;;', 'esac', ''].join('\n'),
      { mode: 0o755 },
    );

    // db: its `docker run` shell has exited, but a client it started still holds the group,
    // so down removes the container and has to keep the entry. api depends on it.
    const memberFile = path.join(path.dirname(projectDir), 'member');
    const leaderScript =
      `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
      `c.unref();require('fs').writeFileSync(${JSON.stringify(memberFile)},String(c.pid));process.exit(0)`;
    const leader = spawn(process.execPath, ['-e', leaderScript], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => leader.once('exit', resolve));
    const member = Number(await fs.readFile(memberFile, 'utf8'));
    const api = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    t.after(() => {
      for (const pid of [member, api.pid!]) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const now = new Date().toISOString();
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: now,
      services: {
        db: { pid: leader.pid!, command: 'docker run', cwd: projectDir, startedAt: now, runMode: 'docker', dockerContainer: 'c-db' },
        api: {
          pid: api.pid!,
          command: 'node',
          cwd: projectDir,
          startedAt: now,
          startToken: (await readProcessStartToken(api.pid!)) ?? undefined,
          runMode: 'local',
          dependsOn: ['db'],
        },
      },
    });

    const down = portlerWith(projectDir, { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, 'down', 'db');
    assert.equal(down.status, 1, 'the entry is kept, so down reports it did not finish');
    // db's entry is kept, so it is not fully stopped yet: the warning names api but offers no command.
    assert.match(
      down.stderr,
      /depending on what was stopped: api \(on db\)\. Stop them too; once db is fully stopped \(see below\), start db again the way it was started\./,
    );
    assert.doesNotMatch(down.stderr, /portler up|portler restart/);
  });

  it('suggests a restart when what the stopped service depends on is still running', async () => {
    const projectDir = await project(
      [
        'services:',
        '  cache:',
        '    command: node server.js',
        '    port: 4110',
        '    port_env: PORT',
        '  db:',
        '    command: node server.js',
        '    port: 4111',
        '    port_env: PORT',
        '    depends_on: [cache]',
        '  api:',
        '    command: node server.js',
        '    port: 4112',
        '    port_env: PORT',
        '    depends_on: [db]',
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    const up = portler(projectDir, 'up', '-d');
    assert.equal(up.status, 0, up.stdout + up.stderr);

    const down = portler(projectDir, 'down', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    // `up -d db` would also start cache, which is still running, and be refused.
    assert.match(down.stderr, /depending on what was stopped: api \(on db\)\. Stop them too, or bring it back with "portler restart db"\./);
    assert.equal(portler(projectDir, 'up', '-d', 'db').status, 1, 'the up form is refused while cache runs');

    const restart = portler(projectDir, 'restart', 'db');
    assert.equal(restart.status, 0, restart.stdout + restart.stderr);
    assert.match(portler(projectDir, 'ps').stdout, /^db\s.*running/m);
  });

  it('offers a restart only when restart, reading every recorded prerequisite, accepts it', async () => {
    const service = (name: string, port: number, deps?: string) =>
      [`  ${name}:`, '    command: node server.js', `    port: ${port}`, '    port_env: PORT', ...(deps ? [`    depends_on: [${deps}]`] : [])];
    const projectDir = await project(
      [
        'services:',
        ...service('cache', 4120),
        ...service('queue', 4121),
        ...service('db', 4122, 'cache, queue'),
        ...service('api', 4123, 'db'),
        '',
      ].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d').status, 0);

    // queue's process is gone, but its entry is still recorded, from a production launch.
    assert.equal(portler(projectDir, 'down', 'queue').status, 0);
    const exited = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => exited.once('exit', resolve));
    const pids = await readPids(projectDir);
    assert.ok(pids);
    pids.services.queue = { pid: exited.pid!, command: 'node server.js', cwd: projectDir, startedAt: new Date().toISOString(), runMode: 'local', prod: true };
    await writePids(projectDir, pids);

    const down = portler(projectDir, 'down', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    // cache alone would allow `restart db`, but restart plans with queue's entry too and refuses.
    assert.match(down.stderr, /depending on what was stopped: api \(on db\)\. Stop them too, or start db again the way it was started\./);
    assert.doesNotMatch(down.stderr, /portler restart|portler up/);
    assert.equal(portler(projectDir, 'restart', 'db').status, 1, 'restart refuses what the warning does not offer');
  });

  it('uses the dependencies each running service recorded when it started', async () => {
    const service = (name: string, port: number, deps?: string) =>
      [`  ${name}:`, '    command: node server.js', `    port: ${port}`, '    port_env: PORT', ...(deps ? [`    depends_on: [${deps}]`] : [])];
    const projectDir = await project(
      ['services:', ...service('db', 4300), ...service('api', 4301, 'db'), ...service('other', 4302), ''].join('\n'),
      { 'server.js': server },
    );
    assert.equal(portler(projectDir, 'up', '-d').status, 0);

    // The file now says the opposite of what is running.
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', ...service('db', 4300), ...service('api', 4301), ...service('other', 4302, 'db'), ''].join('\n'),
    );
    const down = portler(projectDir, 'down', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stderr, /depending on what was stopped: api \(on db\)\. Stop them too, or bring it back with "portler up -d db"\./);
    assert.doesNotMatch(down.stderr, /other/);

    // Run exactly what the warning suggested.
    const back = portler(projectDir, 'up', '-d', 'db');
    assert.equal(back.status, 0, back.stdout + back.stderr);
  });

  // api is deployed and port-forwarded (a stand-in process); db and worker have no port, so
  // no forward. `deleted` is what the fake kubectl reports deleting, `deployed` what it lists.
  async function k8sProject(t: { after: (fn: () => void) => void }, deleted: string[], deployed: string[] = []) {
    const projectDir = await project(
      [
        'services:',
        '  db:',
        '    image: postgres:16-alpine',
        '    k8s: true',
        '  api:',
        '    image: example/api:latest',
        '    port: 8080',
        '    k8s: true',
        '    depends_on: [db]',
        '  worker:',
        '    image: example/worker:latest',
        '    k8s: true',
        '    depends_on: [db]',
        '',
      ].join('\n'),
    );
    const bin = path.join(path.dirname(projectDir), 'bin');
    await fs.mkdir(bin);
    const labels = JSON.stringify({ metadata: { labels: { 'app.kubernetes.io/managed-by': 'portler', 'portler.dev/project': projectHash(projectDir) } } });
    await fs.writeFile(
      path.join(bin, 'kubectl'),
      [
        '#!/bin/sh',
        'case "$*" in',
        '  "config current-context") echo docker-desktop ;;',
        '  "config view"*) echo https://127.0.0.1:6443 ;;',
        `  *"get namespace"*) printf '%s\\n' '${labels}' ;;`,
        // Real kubectl prints "No resources found" on stdout when nothing matches.
        deleted.length > 0
          ? `  *" delete "*) printf '%s\\n' ${deleted.map((name) => `'${name}'`).join(' ')} ;;`
          : `  *" delete "*) echo 'No resources found' ;;`,
        ...(deployed.length > 0 ? [`  *" get deployment "*) printf '%s\\n' ${deployed.map((name) => `'${name}'`).join(' ')} ;;`] : []),
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const forward = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    t.after(() => {
      try {
        process.kill(forward.pid!, 'SIGKILL');
      } catch {}
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writePids(projectDir, {
      version: 1,
      project: projectDir,
      startedAt: new Date().toISOString(),
      services: {
        api: {
          pid: forward.pid!,
          command: 'portler __k8s-forward (kubectl port-forward service/api 55001:8080)',
          cwd: projectDir,
          port: 55001,
          startToken: (await readProcessStartToken(forward.pid!)) ?? undefined,
          startedAt: new Date().toISOString(),
          runMode: 'k8s',
        },
      },
    });
    return { projectDir, env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } };
  }

  it('warns when down k8s deletes a service that has no port-forward', async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shell script as kubectl');
    const { projectDir, env } = await k8sProject(t, ['deployment.apps/db']);

    const down = portlerWith(projectDir, env, 'down', 'k8s', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /deleted Kubernetes resources for: db/);
    assert.doesNotMatch(down.stdout, /no running services found/);
    assert.match(down.stderr, /depending on what was stopped: api \(on db\)\. Stop them too, or start db again the way it was started\./);
    assert.doesNotMatch(down.stderr, /portler up|portler restart/);
  });

  it('warns about a dependent deployed without a port-forward', async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shell script as kubectl');
    const { projectDir, env } = await k8sProject(t, ['deployment.apps/db'], ['deployment.apps/api', 'deployment.apps/worker']);

    // worker has no port, so no PID entry: only the cluster says it still runs.
    const down = portlerWith(projectDir, env, 'down', 'k8s', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stderr, /depending on what was stopped: api \(on db\), worker \(on db\)\./);
  });

  it('takes nothing away when down k8s finds nothing deployed for the service', async (t) => {
    if (process.platform === 'win32') return t.skip('needs a POSIX shell script as kubectl');
    const { projectDir, env } = await k8sProject(t, []);

    // kubectl delete --ignore-not-found succeeds either way; only its output says nothing was there.
    const down = portlerWith(projectDir, env, 'down', 'k8s', 'db');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /no Kubernetes resources found for: db/);
    assert.match(down.stdout, /no running services found/);
    assert.doesNotMatch(down.stderr, /depending on what was stopped/);
  });
});
