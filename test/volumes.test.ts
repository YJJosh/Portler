import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { projectVolumeName } from '../src/config/naming.ts';
import { forkVolume, removeVolume } from '../src/volumes/manager.ts';
import type { PortlerConfig } from '../src/types/index.ts';

let tempDir: string;
let projectDir: string;
let volumeRoot: string;
let callsFile: string;
let oldPath: string;
let oldMode: string | undefined;

function makeConfig(): PortlerConfig {
  return {
    filePath: path.join(projectDir, 'portler.yml'),
    projectDir,
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-test',
    volumeRoot,
    volumes: [{ name: 'data', services: ['api'] }],
    k8sNamespace: 'portler-test',
    services: {},
  };
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-volumes-'));
  projectDir = path.join(tempDir, 'project');
  volumeRoot = projectDir;
  callsFile = path.join(tempDir, 'calls.log');
  const binDir = path.join(tempDir, 'bin');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'version') { console.log('25.0.0'); process.exit(0); }
if (args[0] === 'ps') {
  if (process.env.MOCK_DOCKER_MODE === 'owned-in-use') console.log('api-container');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'inspect') {
  const target = args.at(-1).includes('--branch');
  if (!args.includes('--format')) process.exit(target ? 1 : 0);
  if (process.env.MOCK_DOCKER_MODE === 'inspect-error') {
    console.error('permission denied while connecting to Docker');
    process.exit(1);
  }
  if (process.env.MOCK_DOCKER_MODE === 'target-race') {
    // The source is ours, but a foreign creator wins the target name between
    // the absent check and Docker's idempotent create.
    console.log(target ? 'null' : JSON.stringify({'portler.project': process.env.MOCK_VOLUME_ROOT}));
    process.exit(0);
  }
  if (process.env.MOCK_DOCKER_MODE === 'owned' || process.env.MOCK_DOCKER_MODE === 'owned-in-use') {
    console.log(JSON.stringify({'portler.project': process.env.MOCK_VOLUME_ROOT}));
    process.exit(0);
  }
  if (process.env.MOCK_DOCKER_MODE === 'remove-race') {
    const recorded = fs.readFileSync(process.env.MOCK_DOCKER_CALLS, 'utf8').trim().split('\\n').filter(Boolean);
    const ownershipInspects = recorded
      .map((line) => JSON.parse(line))
      .filter((call) => call[0] === 'volume' && call[1] === 'inspect' && call.includes('--format')).length;
    console.log(ownershipInspects === 1 ? JSON.stringify({'portler.project': process.env.MOCK_VOLUME_ROOT}) : 'null');
    process.exit(0);
  }
  if (process.env.MOCK_DOCKER_MODE === 'foreign') {
    console.log(JSON.stringify({'portler.project': '/another/project'}));
    process.exit(0);
  }
  // Existing but unlabelled: it is foreign, however convincing its name is.
  console.log('null');
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm') process.exit(0);
if (args[0] === 'volume' && args[1] === 'create') { console.log(args.at(-1)); process.exit(0); }
process.exit(0);
`;
  const dockerPath = path.join(binDir, 'docker');
  await fs.writeFile(dockerPath, docker, { mode: 0o755 });

  oldPath = process.env.PATH ?? '';
  oldMode = process.env.MOCK_DOCKER_MODE;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  process.env.MOCK_DOCKER_CALLS = callsFile;
  process.env.MOCK_VOLUME_ROOT = volumeRoot;
});

afterEach(async () => {
  process.env.PATH = oldPath;
  delete process.env.MOCK_DOCKER_CALLS;
  delete process.env.MOCK_VOLUME_ROOT;
  if (oldMode === undefined) delete process.env.MOCK_DOCKER_MODE;
  else process.env.MOCK_DOCKER_MODE = oldMode;
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function calls(): Promise<string[][]> {
  const text = await fs.readFile(callsFile, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

describe('managed volume destructive-operation ownership', () => {
  it('refuses to fork data from an unlabelled/foreign source volume', async () => {
    const config = makeConfig();
    const source = projectVolumeName(volumeRoot, 'data');

    await assert.rejects(forkVolume(config, 'data', 'branch'), /source volume .* is not labelled as this project's/);

    const invoked = await calls();
    assert.ok(invoked.some((args) => args[0] === 'volume' && args[1] === 'inspect' && args.at(-1) === source));
    assert.equal(invoked.some((args) => args[0] === 'run'), false, 'foreign data must never be copied');
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'create'), false);
  });

  it('refuses a foreign target that wins the exists/create race', async () => {
    process.env.MOCK_DOCKER_MODE = 'target-race';
    const config = makeConfig();

    await assert.rejects(forkVolume(config, 'data', 'branch'), /appeared during creation but is not owned/);

    const invoked = await calls();
    assert.ok(invoked.some((args) => args[0] === 'volume' && args[1] === 'create'));
    assert.equal(invoked.some((args) => args[0] === 'run'), false, 'foreign target data must never be overwritten');
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'rm'), false, 'foreign target must not be rollback-removed');
  });

  it('never removes an unlabelled legacy volume, even with --force', async () => {
    const config = makeConfig();
    const fullName = projectVolumeName(volumeRoot, 'data');

    await assert.rejects(
      removeVolume(config, 'data', true),
      /will not delete it, even with --force.*docker volume inspect .*remove it manually with "docker volume rm/s,
    );

    const invoked = await calls();
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'rm'), false, 'legacy volume must be removed manually');
    assert.ok(invoked.some((args) => args[0] === 'volume' && args[1] === 'inspect' && args.at(-1) === fullName));
  });

  it('never removes a volume labelled for another project, even with --force', async () => {
    process.env.MOCK_DOCKER_MODE = 'foreign';
    const config = makeConfig();

    await assert.rejects(removeVolume(config, 'data', true), /not labelled as this project's.*even with --force/s);

    const invoked = await calls();
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'rm'), false, 'foreign volume must never be removed');
  });

  it('rechecks ownership at removal and refuses a foreign replacement, even with --force', async () => {
    process.env.MOCK_DOCKER_MODE = 'remove-race';
    const config = makeConfig();

    await assert.rejects(removeVolume(config, 'data', true), /ownership .* changed while preparing to remove it/);

    const invoked = await calls();
    const ownershipInspects = invoked.filter(
      (args) => args[0] === 'volume' && args[1] === 'inspect' && args.includes('--format'),
    );
    assert.equal(ownershipInspects.length, 2);
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'rm'), false, 'replacement volume must never be removed');
  });

  it('treats an ownership-inspection failure as a refusal, even with --force', async () => {
    process.env.MOCK_DOCKER_MODE = 'inspect-error';
    const config = makeConfig();

    await assert.rejects(removeVolume(config, 'data', true), /could not determine ownership/);

    const invoked = await calls();
    assert.equal(invoked.some((args) => args[0] === 'volume' && args[1] === 'rm'), false, 'unknown ownership must fail closed');
  });

  it('--force bypasses only the in-use guard for an owned volume', async () => {
    process.env.MOCK_DOCKER_MODE = 'owned-in-use';
    const config = makeConfig();
    const fullName = projectVolumeName(volumeRoot, 'data');

    await assert.rejects(removeVolume(config, 'data', false), /is in use by api-container/);
    assert.equal((await calls()).some((args) => args[0] === 'volume' && args[1] === 'rm'), false);

    assert.equal(await removeVolume(config, 'data', true), fullName);
    const removeCall = (await calls()).findLast((args) => args[0] === 'volume' && args[1] === 'rm');
    assert.deepEqual(removeCall, ['volume', 'rm', '-f', fullName]);
  });
});

describe('concurrent forks into the same target', () => {
  let stateDir: string;

  // A stateful fake: one JSON file of labels per volume. `volume create` keeps an
  // existing volume and its labels and still succeeds, like Docker 29 (or fails
  // with MOCK_CREATE_CONFLICT, like a Docker that refuses), and the absent-target
  // check waits until two forks have both seen the target absent.
  beforeEach(async () => {
    stateDir = path.join(tempDir, 'state');
    await fs.mkdir(path.join(stateDir, 'volumes'), { recursive: true });
    await fs.mkdir(path.join(stateDir, 'barrier'), { recursive: true });
    process.env.MOCK_DOCKER_STATE = stateDir;

    const docker = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_CALLS, JSON.stringify(args) + '\\n');
const state = process.env.MOCK_DOCKER_STATE;
const file = (name) => path.join(state, 'volumes', name + '.json');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const absent = (name) => { console.error('Error response from daemon: get ' + name + ': no such volume'); process.exit(1); };
if (args[0] === 'version') { console.log('29.0.0'); process.exit(0); }
if (args[0] === 'ps') process.exit(0);
if (args[0] === 'volume' && args[1] === 'inspect') {
  const name = args.at(-1);
  if (!fs.existsSync(file(name))) {
    if (!args.includes('--format') && name.endsWith('--merged') && process.env.MOCK_BARRIER) {
      const barrier = path.join(state, 'barrier');
      fs.writeFileSync(path.join(barrier, String(process.pid)), '');
      const deadline = Date.now() + 10000;
      while (fs.readdirSync(barrier).length < 2 && Date.now() < deadline) sleep(20);
    }
    absent(name);
  }
  if (args.includes('--format')) console.log(fs.readFileSync(file(name), 'utf8'));
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'create') {
  const name = args.at(-1);
  const labels = {};
  args.forEach((arg, index) => {
    if (args[index - 1] === '--label') labels[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1);
  });
  try {
    fs.writeFileSync(file(name), JSON.stringify(labels), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (process.env.MOCK_CREATE_CONFLICT) { console.error('Error response from daemon: volume ' + name + ' already exists'); process.exit(1); }
  }
  console.log(name);
  process.exit(0);
}
if (args[0] === 'volume' && args[1] === 'rm') { fs.rmSync(file(args.at(-1))); process.exit(0); }
if (args[0] === 'run') {
  if (process.env.MOCK_COPY_FAIL === 'replaced') {
    // Our target is removed and a concurrent fork of the same project recreates the name.
    const target = args.find((arg) => arg.endsWith(':/to')).slice(0, -':/to'.length);
    const labels = JSON.parse(fs.readFileSync(file(target), 'utf8'));
    fs.writeFileSync(file(target), JSON.stringify({ ...labels, 'portler.fork-attempt': 'another-attempt' }));
  }
  if (process.env.MOCK_COPY_FAIL) { console.error('cp: write error'); process.exit(1); }
  process.exit(0);
}
process.exit(0);
`;
    await fs.writeFile(path.join(tempDir, 'bin', 'docker'), docker, { mode: 0o755 });
  });

  afterEach(() => {
    delete process.env.MOCK_DOCKER_STATE;
    delete process.env.MOCK_BARRIER;
    delete process.env.MOCK_CREATE_CONFLICT;
    delete process.env.MOCK_COPY_FAIL;
  });

  async function seedSource(volumeSet: string): Promise<string> {
    const name = projectVolumeName(volumeRoot, 'data', volumeSet);
    const labels = { 'portler.project': volumeRoot, 'portler.volume': 'data', 'portler.volume-set': volumeSet };
    await fs.writeFile(path.join(stateDir, 'volumes', `${name}.json`), JSON.stringify(labels));
    return name;
  }

  function copiesInto(invoked: string[][], target: string): string[][] {
    return invoked.filter((args) => args[0] === 'run' && args.includes(`${target}:/to`));
  }

  for (const conflict of [false, true]) {
    it(`lets only one of two racing forks copy into the target${conflict ? ' when create refuses an existing name' : ''}`, async () => {
      process.env.MOCK_BARRIER = '1';
      if (conflict) process.env.MOCK_CREATE_CONFLICT = '1';
      const config = makeConfig();
      await seedSource('one');
      await seedSource('two');
      const target = projectVolumeName(volumeRoot, 'data', 'merged');

      const results = await Promise.allSettled([forkVolume(config, 'data--one', 'merged'), forkVolume(config, 'data--two', 'merged')]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      assert.equal(fulfilled.length, 1, 'exactly one fork may succeed');
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0]!.reason), /another fork created target volume .* at the same time/);
      assert.equal(copiesInto(await calls(), target).length, 1, 'two datasets must never be copied into one target');
      assert.equal((await calls()).some((args) => args[0] === 'volume' && args[1] === 'rm'), false);
    });
  }

  it('rolls back a target this attempt created when the copy fails', async () => {
    process.env.MOCK_COPY_FAIL = '1';
    const config = makeConfig();
    await seedSource('one');
    const target = projectVolumeName(volumeRoot, 'data', 'merged');

    await assert.rejects(forkVolume(config, 'data--one', 'merged'), /copying volume data failed/);

    assert.ok((await calls()).some((args) => args[0] === 'volume' && args[1] === 'rm' && args.at(-1) === target));
    await assert.rejects(fs.access(path.join(stateDir, 'volumes', `${target}.json`)));
  });

  it('never rolls back a same-project target that another fork created', async () => {
    process.env.MOCK_COPY_FAIL = 'replaced';
    const config = makeConfig();
    await seedSource('one');
    const target = projectVolumeName(volumeRoot, 'data', 'merged');

    await assert.rejects(forkVolume(config, 'data--one', 'merged'), /copying volume data failed/);

    assert.equal((await calls()).some((args) => args[0] === 'volume' && args[1] === 'rm'), false, "another fork's target must survive");
    await fs.access(path.join(stateDir, 'volumes', `${target}.json`));
  });
});
