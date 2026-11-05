/** A failed rollout names why its pods did not start, not only "timed out". */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { waitForRollout } from '../src/k8s/kubectl.ts';
import type { PortlerConfig } from '../src/types/index.ts';

// `rollout status` fails like a real timeout; `get pods` reports FAKE_PODS.
const kubectl = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('rollout')) {
  console.error('error: timed out waiting for the condition');
  process.exit(1);
}
if (args.includes('pods')) {
  if (process.env.FAKE_PODS === 'fail') process.exit(1);
  console.log(process.env.FAKE_PODS);
}
`;

let dir = '';
let savedPath: string | undefined;
const cluster = { type: 'unknown', context: 'lab' } as never;
const config = { k8sNamespace: 'ns' } as PortlerConfig;
const pods = (...waiting: Array<{ reason: string; message?: string }>) =>
  JSON.stringify({ items: [{ status: { containerStatuses: waiting.map((state) => ({ state: { waiting: state } })) } }] });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-rollout-'));
  await fs.writeFile(path.join(dir, 'kubectl'), kubectl, { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
});

afterEach(async () => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_PODS;
  await fs.rm(dir, { recursive: true, force: true });
});

it('names an image pull failure and how to get the image there', async () => {
  process.env.FAKE_PODS = pods({ reason: 'ImagePullBackOff', message: 'Back-off pulling image "app:latest"\nmore' });
  await assert.rejects(waitForRollout(cluster, config, 'web', 'web'), (error: Error) => {
    assert.match(error.message, /web's pod did not start: ImagePullBackOff: Back-off pulling image "app:latest"$/m);
    assert.match(error.message, /must pull it from a registry/);
    return true;
  });
});

it('names other waiting reasons without the image hint', async () => {
  process.env.FAKE_PODS = pods({ reason: 'CrashLoopBackOff' }, { reason: 'ContainerCreating' });
  await assert.rejects(waitForRollout(cluster, config, 'web', 'web'), (error: Error) => {
    assert.match(error.message, /web's pod did not start: CrashLoopBackOff$/m);
    assert.doesNotMatch(error.message, /registry|ContainerCreating/);
    return true;
  });
});

it('keeps the original error when the pods cannot be read or show nothing', async () => {
  for (const value of ['fail', pods()]) {
    process.env.FAKE_PODS = value;
    await assert.rejects(waitForRollout(cluster, config, 'web', 'web'), (error: Error) => {
      assert.doesNotMatch(error.message, /did not start/);
      return true;
    });
  }
});
