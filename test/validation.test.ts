import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config/loader.ts';
import { normalizeHealthcheck } from '../src/config/healthcheck.ts';

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-validation-'));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<string> {
  await fs.writeFile(path.join(projectDir, 'portler.yml'), yaml, 'utf8');
  return projectDir;
}

describe('port validation', () => {
  it('accepts a valid port', async () => {
    const config = await loadConfig(await writeConfig('services:\n  api:\n    command: x\n    port: 3000\n'));
    assert.equal(config.services.api!.port, 3000);
  });

  it('rejects port 0, which would mean "any port" to the OS', async () => {
    // Port 0 makes the kernel pick a random port, quietly defeating the entire
    // point of Portler's assignment and leaving state.json describing a port
    // nothing is on.
    await assert.rejects(
      loadConfig(await writeConfig('services:\n  api:\n    command: x\n    port: 0\n')),
      /services\.api\.port must be a port between 1 and 65535, got 0/,
    );
  });

  it('rejects a negative or out-of-range port', async () => {
    await assert.rejects(
      loadConfig(await writeConfig('services:\n  api:\n    command: x\n    port: -1\n')),
      /must be a port between 1 and 65535/,
    );
    await assert.rejects(
      loadConfig(await writeConfig('services:\n  api:\n    command: x\n    port: 70000\n')),
      /must be a port between 1 and 65535/,
    );
  });
});

describe('port range validation', () => {
  it('rejects an out-of-range bound inside port_range', async () => {
    await assert.rejects(
      loadConfig(await writeConfig('port_range:\n  start: 0\n  end: 100\nservices:\n  api:\n    command: x\n')),
      /port_range\.start must be a port between 1 and 65535/,
    );
  });

  it('rejects an out-of-range bound given via the top-level keys', async () => {
    // The old code only range-checked when a `port_range:` object was present,
    // so `port_start: 0` sailed straight through.
    await assert.rejects(
      loadConfig(await writeConfig('port_start: 0\nport_end: 100\nservices:\n  api:\n    command: x\n')),
      /port_start must be a port between 1 and 65535/,
    );
    await assert.rejects(
      loadConfig(await writeConfig('port_start: 1\nport_end: 99999\nservices:\n  api:\n    command: x\n')),
      /port_end must be a port between 1 and 65535/,
    );
  });

  it('rejects an inverted range', async () => {
    await assert.rejects(
      loadConfig(await writeConfig('port_range:\n  start: 6000\n  end: 5000\nservices:\n  api:\n    command: x\n')),
      /invalid port range 6000-5000/,
    );
  });
});

describe('healthcheck duration validation', () => {
  it('accepts positive durations', () => {
    const healthcheck = normalizeHealthcheck({ timeout_ms: 5_000, interval_ms: 100 }, 'api');
    assert.equal(healthcheck?.timeoutMs, 5_000);
    assert.equal(healthcheck?.intervalMs, 100);
  });

  it('rejects a zero interval, which would busy-loop the readiness poll', () => {
    assert.throws(
      () => normalizeHealthcheck({ interval_ms: 0 }, 'api'),
      /services\.api\.healthcheck\.interval_ms must be greater than 0/,
    );
  });

  it('rejects a zero or negative timeout, which can never pass', () => {
    assert.throws(() => normalizeHealthcheck({ timeout_ms: 0 }, 'api'), /must be greater than 0/);
    assert.throws(() => normalizeHealthcheck({ timeout_ms: -1 }, 'api'), /must be greater than 0/);
  });

  it('rejects negative durations in camelCase form too', () => {
    assert.throws(() => normalizeHealthcheck({ intervalMs: -5 }, 'api'), /must be greater than 0/);
    assert.throws(() => normalizeHealthcheck({ timeoutMs: -5 }, 'api'), /must be greater than 0/);
  });

  it('rejects durations that Node would clamp to a 1ms timer', () => {
    assert.throws(() => normalizeHealthcheck({ interval_ms: 2_147_483_648 }, 'api'), /must not exceed 2147483647ms/);
  });
});

describe('Kubernetes replica validation', () => {
  it('rejects replicas: 0 because up k8s can never observe a stable pod', async () => {
    await assert.rejects(
      loadConfig(await writeConfig('services:\n  api:\n    image: example/api\n    k8s:\n      replicas: 0\n')),
      /replicas must be at least 1/,
    );
  });

  it('rejects replica counts outside JavaScript safe-integer precision', async () => {
    await assert.rejects(
      loadConfig(await writeConfig('services:\n  api:\n    image: example/api\n    k8s:\n      replicas: 9007199254740992\n')),
      /integer within JavaScript's safe range/,
    );
  });
});
