/**
 * `env` and `down k8s` act on the kubectl context `up k8s` deployed to, not on whichever
 * one is active by then. These drive the real CLI against a fake kubectl with several
 * contexts, each remembering the Deployments applied to it; no cluster is used.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { launchContextPath, readLaunchContext } from '../src/k8s/launch-context.ts';
import { projectHash } from '../src/util/hash.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));

// The current context and the kubeconfig's contexts come from files the test rewrites;
// every call is logged. A context named in FAKE_KUBECTL_BROKEN answers nothing, and
// FAKE_KUBECTL_FAIL_APPLY makes every apply fail.
const kubectl = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_KUBECTL_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const contexts = fs.readFileSync(path.join(dir, 'contexts'), 'utf8').split('\\n').filter(Boolean);
const context = args[0] === '--context' ? args[1] : undefined;
const rest = context === undefined ? args : args.slice(2);
const stateFile = path.join(dir, 'deployed-' + context + '.json');
const deployed = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : []);
if (rest[0] === 'config' && rest[1] === 'current-context') {
  console.log(fs.readFileSync(path.join(dir, 'current'), 'utf8').trim());
} else if (rest[0] === 'config' && rest[1] === 'get-contexts') {
  for (const name of contexts) console.log(name);
} else if (rest[0] === 'config' && rest[1] === 'view') {
  const named = rest[rest.indexOf('--context') + 1];
  if (!contexts.includes(named)) {
    console.error('error: context "' + named + '" does not exist');
    process.exit(1);
  }
  console.log('https://127.0.0.1:6443');
} else if (context !== undefined && context === process.env.FAKE_KUBECTL_BROKEN) {
  console.error('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused');
  process.exit(1);
} else if (rest[0] === 'get' && rest[1] === 'namespace') {
  if (rest.some((arg) => arg.includes('jsonpath'))) console.log('Active');
  else console.log(JSON.stringify({metadata: {labels: {
    'app.kubernetes.io/managed-by': 'portler',
    'portler.dev/project': process.env.FAKE_KUBECTL_PROJECT,
  }}}));
} else if (rest[0] === 'get' && rest[1] === 'pods') {
  console.log(JSON.stringify({items: [{status: {
    phase: 'Running',
    conditions: [{type: 'Ready', status: 'True'}],
    containerStatuses: [{restartCount: 0}],
  }}]}));
} else if (rest[0] === 'get' && rest[1] === 'deployment') {
  const names = deployed();
  if (names.length === 0) console.log('No resources found');
  for (const name of names) console.log('deployment.apps/' + name);
} else if (rest[0] === 'apply' && process.env.FAKE_KUBECTL_FAIL_APPLY) {
  console.error('error: the server rejected the manifest');
  process.exit(1);
} else if (rest[0] === 'apply') {
  const names = new Set(deployed());
  rest.forEach((arg, index) => { if (arg === '-f') names.add(path.basename(rest[index + 1], '.yml')); });
  fs.writeFileSync(stateFile, JSON.stringify([...names]));
} else if (rest[0] === 'delete') {
  const selector = rest[rest.indexOf('--selector') + 1] || '';
  const match = selector.match(/app in \\(([^)]+)\\)/);
  const names = deployed();
  const removed = names.filter((name) => !match || match[1].split(',').includes(name));
  fs.writeFileSync(stateFile, JSON.stringify(names.filter((name) => !removed.includes(name))));
  if (removed.length === 0) console.log('No resources found');
  for (const name of removed) console.log('deployment.apps/' + name);
}
`;

const CONFIG = `services:
  worker:
    image: example/worker:latest
    env: {MODE: local}
    docker:
      image: example/worker:latest
      env: {MODE: docker}
  cron:
    image: example/cron:latest
`;

let tempDir: string;
let projectDir: string;
let fakeDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  tempDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-k8s-context-')));
  projectDir = path.join(tempDir, 'project');
  fakeDir = path.join(tempDir, 'kubectl');
  const bin = path.join(tempDir, 'bin');
  await Promise.all([projectDir, fakeDir, bin].map((dir) => fs.mkdir(dir, { recursive: true })));
  await fs.writeFile(path.join(bin, 'kubectl'), kubectl, { mode: 0o755 });
  await fs.writeFile(path.join(projectDir, 'portler.yml'), CONFIG, 'utf8');
  await fs.writeFile(path.join(fakeDir, 'calls.log'), '', 'utf8');
  await setContexts(['kind-a', 'kind-b'], 'kind-a');
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    PORTLER_GLOBAL_DIR: path.join(tempDir, 'global'),
    FAKE_KUBECTL_DIR: fakeDir,
    FAKE_KUBECTL_PROJECT: projectHash(projectDir),
    // The record names the kubeconfig `up k8s` read; the fake kubectl ignores it.
    KUBECONFIG: path.join(tempDir, 'kubeconfig'),
  };
  delete env.MODE;
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function setContexts(contexts: string[], current: string): Promise<void> {
  await fs.writeFile(path.join(fakeDir, 'contexts'), contexts.join('\n'), 'utf8');
  await fs.writeFile(path.join(fakeDir, 'current'), current, 'utf8');
}

function portler(...args: string[]) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: projectDir,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

async function deployedIn(context: string): Promise<string[]> {
  const file = path.join(fakeDir, `deployed-${context}.json`);
  return JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]')) as string[];
}

/** The calls since the last one, so each step's kubectl traffic can be read on its own. */
async function takeCalls(): Promise<string[][]> {
  const file = path.join(fakeDir, 'calls.log');
  const calls = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  await fs.writeFile(file, '', 'utf8');
  return calls;
}

const pinnedTo = (calls: string[][], context: string) => calls.filter((call) => call[0] === '--context' && call[1] === context);
const mutating = (calls: string[][]) => calls.filter((call) => call.includes('apply') || call.includes('delete') || call.includes('create'));

async function writeRecord(context: string, kubeconfig = env.KUBECONFIG!): Promise<void> {
  await fs.mkdir(path.dirname(launchContextPath(projectDir)), { recursive: true });
  await fs.writeFile(
    launchContextPath(projectDir),
    JSON.stringify({ version: 1, project: projectDir, context, kubeconfig, recordedAt: new Date().toISOString() }),
    'utf8',
  );
}

describe('the kubectl context up k8s deployed to', () => {
  it('is where env and down k8s look after a context switch, and up k8s will not start elsewhere meanwhile', { timeout: 120_000 }, async () => {
    const up = portler('up', 'k8s', '-d');
    assert.equal(up.status, 0, up.output);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');
    assert.deepEqual((await deployedIn('kind-a')).sort(), ['cron', 'worker']);
    await takeCalls();

    await setContexts(['kind-a', 'kind-b'], 'kind-b');

    // worker has no port, so no port-forward entry: only the cluster knows it runs.
    const shown = portler('env', 'worker');
    assert.equal(shown.status, 0, shown.output);
    assert.match(shown.stderr, /worker was started with "portler up k8s"; this shows the environment it got/);
    assert.match(shown.stdout, /^MODE="?docker"?$/m);
    let calls = await takeCalls();
    assert.ok(pinnedTo(calls, 'kind-a').some((call) => call.includes('deployment')), JSON.stringify(calls));
    assert.deepEqual(pinnedTo(calls, 'kind-b'), []);

    const elsewhere = portler('up', 'k8s', '-d');
    assert.equal(elsewhere.status, 1, elsewhere.output);
    assert.match(elsewhere.stderr, /still runs in kubectl context "kind-a" \((worker, cron|cron, worker)\)/);
    assert.match(elsewhere.stderr, /active context is "kind-b"/);
    assert.deepEqual(mutating(await takeCalls()), []);
    assert.deepEqual(await deployedIn('kind-b'), []);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');

    // A partial down leaves the rest running there, so the record stays.
    const partial = portler('down', 'k8s', 'cron');
    assert.equal(partial.status, 0, partial.output);
    assert.deepEqual(await deployedIn('kind-a'), ['worker']);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');

    const down = portler('down', 'k8s');
    assert.equal(down.status, 0, down.output);
    assert.match(down.stdout, /kubectl context: kind-a \(kind\), where "portler up k8s" started this project/);
    calls = await takeCalls();
    assert.deepEqual(mutating(calls).map((call) => call[1]), ['kind-a', 'kind-a']);
    assert.deepEqual(pinnedTo(calls, 'kind-b'), []);
    assert.deepEqual(await deployedIn('kind-a'), []);
    assert.equal(await readLaunchContext(projectDir), null, 'a full down k8s ends the launch');

    // With nothing recorded, the active context is used again.
    const moved = portler('up', 'k8s', '-d');
    assert.equal(moved.status, 0, moved.output);
    assert.equal(await readLaunchContext(projectDir), 'kind-b');
    assert.deepEqual((await deployedIn('kind-b')).sort(), ['cron', 'worker']);
    assert.equal(portler('down', 'k8s').status, 0);
  });

  it('is replaced by up k8s once nothing runs there any more', { timeout: 60_000 }, async () => {
    await writeRecord('kind-a');
    await setContexts(['kind-a', 'kind-b'], 'kind-b');
    const up = portler('up', 'k8s', '-d', 'cron');
    assert.equal(up.status, 0, up.output);
    assert.equal(await readLaunchContext(projectDir), 'kind-b');
    assert.deepEqual(await deployedIn('kind-b'), ['cron']);
    assert.ok(pinnedTo(await takeCalls(), 'kind-a').some((call) => call.includes('deployment')), 'asked kind-a first');
  });

  // A full `down k8s` there would still delete it by label.
  it('counts a Deployment of a service since removed from portler.yml as still running there', async () => {
    await writeRecord('kind-a');
    await fs.writeFile(path.join(fakeDir, 'deployed-kind-a.json'), JSON.stringify(['retired']), 'utf8');
    await setContexts(['kind-a', 'kind-b'], 'kind-b');
    const up = portler('up', 'k8s', '-d', 'cron');
    assert.equal(up.status, 1, up.output);
    assert.match(up.stderr, /still runs in kubectl context "kind-a" \(retired\)/);
    assert.deepEqual(mutating(await takeCalls()), []);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');
  });

  it('keeps up k8s from starting elsewhere while that cluster cannot be asked', async () => {
    await writeRecord('kind-a');
    await setContexts(['kind-a', 'kind-b'], 'kind-b');
    env.FAKE_KUBECTL_BROKEN = 'kind-a';
    const up = portler('up', 'k8s', '-d');
    assert.equal(up.status, 1, up.output);
    assert.match(up.stderr, /could not ask that cluster whether it still runs there/);
    assert.match(up.stderr, /"portler clean" forgets it/);
    assert.deepEqual(mutating(await takeCalls()), []);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');

    // down k8s fails on it too, instead of deleting in the active cluster.
    const down = portler('down', 'k8s');
    assert.equal(down.status, 1, down.output);
    assert.match(down.stdout, /kubectl context: kind-a \(kind\), where "portler up k8s" started this project/);
    assert.match(down.stderr, /could not determine whether namespace/);
    assert.deepEqual(pinnedTo(await takeCalls(), 'kind-b'), []);
    assert.equal(await readLaunchContext(projectDir), 'kind-a');
  });

  it('is forgotten once the kubeconfig no longer has it', { timeout: 60_000 }, async () => {
    await writeRecord('kind-gone');
    await setContexts(['kind-b'], 'kind-b');
    // `.portler/k8s/` makes env ask the cluster at all.
    await fs.mkdir(path.join(projectDir, '.portler', 'k8s'), { recursive: true });
    await fs.writeFile(path.join(projectDir, '.portler', 'k8s', '00-namespace.yml'), 'kind: Namespace\n', 'utf8');

    const shown = portler('env', 'worker');
    assert.equal(shown.status, 0, shown.output);
    assert.match(shown.stderr, /could not ask the cluster whether worker runs there/);
    assert.deepEqual(pinnedTo(await takeCalls(), 'kind-b'), [], 'env does not ask the active cluster instead');

    const down = portler('down', 'k8s');
    assert.equal(down.status, 0, down.output);
    assert.match(down.stderr, /kubectl context "kind-gone", where "portler up k8s" started this project, no longer exists/);
    assert.deepEqual(mutating(await takeCalls()), []);
    assert.equal(await readLaunchContext(projectDir), null);

    await writeRecord('kind-gone');
    const up = portler('up', 'k8s', '-d', 'cron');
    assert.equal(up.status, 0, up.output);
    assert.match(up.stderr, /"kind-gone", where "portler up k8s" last started this project, no longer exists; starting in "kind-b"/);
    assert.equal(await readLaunchContext(projectDir), 'kind-b');
  });

  // A shell with another KUBECONFIG does not see the context, but the stack may still
  // run there: neither forget it nor start elsewhere.
  it('is kept when this command reads another kubeconfig than up k8s did', { timeout: 60_000 }, async () => {
    await writeRecord('kind-other', path.join(tempDir, 'other-kubeconfig'));
    await setContexts(['kind-b'], 'kind-b');

    const down = portler('down', 'k8s');
    assert.equal(down.status, 1, down.output);
    assert.match(down.stderr, /kubectl context "kind-other", where "portler up k8s" started this project, comes from a different kubeconfig/);
    assert.match(down.stderr, new RegExp(`"portler up k8s" read ${path.join(tempDir, 'other-kubeconfig')}, this command reads `));
    assert.match(down.stderr, new RegExp(`KUBECONFIG=${path.join(tempDir, 'other-kubeconfig')}`));
    assert.equal(await readLaunchContext(projectDir), 'kind-other');

    const up = portler('up', 'k8s', '-d', 'cron');
    assert.equal(up.status, 1, up.output);
    assert.match(up.stderr, /will not start it in "kind-b" as well/);
    assert.deepEqual(mutating(await takeCalls()), []);
    assert.equal(await readLaunchContext(projectDir), 'kind-other');

    // Relative KUBECONFIG paths name the same file as up k8s's absolute one.
    env.KUBECONFIG = path.relative(projectDir, path.join(tempDir, 'other-kubeconfig'));
    const sameFile = portler('down', 'k8s');
    assert.equal(sameFile.status, 0, sameFile.output);
    assert.match(sameFile.stderr, /"kind-other", where "portler up k8s" started this project, no longer exists/);
    assert.equal(await readLaunchContext(projectDir), null);
  });

  // Both kubeconfigs can have a kind-a that points at different clusters: the name being
  // there (even as the active context) must not let a delete or a start through.
  for (const active of ['kind-a', 'kind-b']) {
    it(`refuses another kubeconfig with the recorded context present (active ${active})`, async () => {
      await writeRecord('kind-a', path.join(tempDir, 'original-kubeconfig'));
      await setContexts(['kind-a', 'kind-b'], active);
      await fs.writeFile(path.join(fakeDir, 'deployed-kind-a.json'), JSON.stringify(['worker']));
      const originalRecord = await fs.readFile(launchContextPath(projectDir), 'utf8');

      const down = portler('down', 'k8s');
      assert.equal(down.status, 1, down.output);
      assert.match(down.stderr, /different kubeconfig/);
      const up = portler('up', 'k8s', '-d', 'cron');
      assert.equal(up.status, 1, up.output);
      assert.match(up.stderr, /different kubeconfig/);
      assert.deepEqual(mutating(await takeCalls()), []);
      assert.equal(await fs.readFile(launchContextPath(projectDir), 'utf8'), originalRecord);
      assert.deepEqual(await deployedIn('kind-a'), ['worker']);
    });
  }

  it('is taken back by a start that removes all it started, unless an earlier start recorded it', { timeout: 60_000 }, async () => {
    await setContexts(['kind-a', 'kind-b'], 'kind-a');
    env.FAKE_KUBECTL_FAIL_APPLY = '1';
    const failed = portler('up', 'k8s', '-d', 'cron');
    assert.equal(failed.status, 1, failed.output);
    assert.equal(await readLaunchContext(projectDir), null, 'a stale record would block up k8s elsewhere');

    delete env.FAKE_KUBECTL_FAIL_APPLY;
    assert.equal(portler('up', 'k8s', '-d', 'worker').status, 0);
    env.FAKE_KUBECTL_FAIL_APPLY = '1';
    const again = portler('up', 'k8s', '-d', 'cron');
    assert.equal(again.status, 1, again.output);
    assert.equal(await readLaunchContext(projectDir), 'kind-a', 'worker still runs there');
    assert.deepEqual(await deployedIn('kind-a'), ['worker']);

    delete env.FAKE_KUBECTL_FAIL_APPLY;
    assert.equal(portler('down', 'k8s').status, 0);
  });
});
