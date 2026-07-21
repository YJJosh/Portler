import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { describe, it } from 'node:test';
import { normalizeHealthcheck } from '../src/config/healthcheck.ts';
import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from '../src/constants.ts';
import { waitForServiceReady } from '../src/readiness/index.ts';
import type { Assignments, PortlerConfig, ServiceAssignment, ServiceConfig } from '../src/types/index.ts';

describe('normalizeHealthcheck', () => {
  it('returns undefined for absent values', () => {
    assert.equal(normalizeHealthcheck(undefined, 'api'), undefined);
    assert.equal(normalizeHealthcheck(null, 'api'), undefined);
  });

  it('normalizes "none" and false to a none check', () => {
    for (const value of ['none', false]) {
      assert.deepEqual(normalizeHealthcheck(value, 'api'), {
        type: 'none',
        timeoutMs: DEFAULT_HEALTHCHECK_TIMEOUT_MS,
        intervalMs: DEFAULT_HEALTHCHECK_INTERVAL_MS,
      });
    }
  });

  it('accepts type names as strings', () => {
    assert.equal(normalizeHealthcheck('tcp', 'api')?.type, 'tcp');
    assert.equal(normalizeHealthcheck('http', 'api')?.type, 'http');
    assert.equal(normalizeHealthcheck('command', 'api')?.type, 'command');
    assert.throws(() => normalizeHealthcheck('carrier-pigeon', 'api'), /must be one of: none, tcp, http, command/);
  });

  it('infers the type from object keys', () => {
    assert.equal(normalizeHealthcheck({ command: 'true' }, 'api')?.type, 'command');
    assert.equal(normalizeHealthcheck({ test: 'true' }, 'api')?.type, 'command');
    assert.equal(normalizeHealthcheck({ url: 'http://localhost/health' }, 'api')?.type, 'http');
    assert.equal(normalizeHealthcheck({}, 'api')?.type, 'tcp');
  });

  it('supports the compose-style test alias for command', () => {
    assert.equal(normalizeHealthcheck({ test: 'pg_isready' }, 'api')?.command, 'pg_isready');
  });

  it('reads snake_case and camelCase timing options', () => {
    assert.equal(normalizeHealthcheck({ timeout_ms: 5000 }, 'api')?.timeoutMs, 5000);
    assert.equal(normalizeHealthcheck({ timeoutMs: 6000 }, 'api')?.timeoutMs, 6000);
    assert.equal(normalizeHealthcheck({ interval_ms: 100 }, 'api')?.intervalMs, 100);
    assert.equal(normalizeHealthcheck({ intervalMs: 200 }, 'api')?.intervalMs, 200);
  });

  it('applies default timings', () => {
    const healthcheck = normalizeHealthcheck({ command: 'true' }, 'api');
    assert.equal(healthcheck?.timeoutMs, DEFAULT_HEALTHCHECK_TIMEOUT_MS);
    assert.equal(healthcheck?.intervalMs, DEFAULT_HEALTHCHECK_INTERVAL_MS);
  });

  it('rejects invalid shapes', () => {
    assert.throws(() => normalizeHealthcheck(42, 'api'), /must be a string or object/);
    assert.throws(() => normalizeHealthcheck({ type: 'websocket' }, 'api'), /must be one of/);
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

function makeConfig(): PortlerConfig {
  return {
    filePath: `${os.tmpdir()}/portler.yml`,
    projectDir: os.tmpdir(),
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: os.tmpdir(),
    volumes: [],
    k8sNamespace: 'portler-test',
    services: {},
  };
}

function makeAssignment(port: number): ServiceAssignment {
  return {
    name: 'api',
    port,
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    url: `http://localhost:${port}`,
  };
}

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const notExited = (): boolean => false;
const commandEnv = { PATH: process.env.PATH ?? '' };

describe('waitForServiceReady', () => {
  it('returns immediately for none healthchecks', async () => {
    const service = makeService({
      healthcheck: { type: 'none', timeoutMs: 50, intervalMs: 10 },
    });
    await waitForServiceReady(makeConfig(), service, {}, {}, undefined, notExited);
  });

  it('defaults to none when the service has no port assignment', async () => {
    const service = makeService({});
    await waitForServiceReady(makeConfig(), service, {}, {}, undefined, notExited);
  });

  it('passes a tcp check once something listens on the assigned port', async () => {
    const server = net.createServer();
    const port = await listen(server);
    try {
      const service = makeService({
        port: 4000,
        healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('times out when nothing listens on the assigned port', async () => {
    const port = await findFreePort();
    const service = makeService({
      port: 4000,
      healthcheck: { type: 'tcp', timeoutMs: 200, intervalMs: 25 },
    });
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited),
      /service "api" was not ready after/,
    );
  });

  it('fails fast when the child process exits before becoming ready', async () => {
    const port = await findFreePort();
    const service = makeService({
      port: 4000,
      healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 },
    });
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), () => true),
      /exited before it became ready/,
    );
  });

  it('passes an http check for responses below 500', async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 404;
      response.end('not found, but alive');
    });
    const port = await listen(server);
    try {
      const service = makeService({
        port: 4000,
        healthcheck: { type: 'http', timeoutMs: 5_000, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('treats http 5xx as not ready', async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 503;
      response.end('warming up');
    });
    const port = await listen(server);
    try {
      const service = makeService({
        port: 4000,
        healthcheck: { type: 'http', timeoutMs: 200, intervalMs: 25 },
      });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited),
        /was not ready after/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('enforces the overall timeout when an HTTP server accepts but never responds', async () => {
    const server = http.createServer(() => {
      // Deliberately leave the response open forever.
    });
    const port = await listen(server);
    const startedAt = Date.now();
    try {
      const service = makeService({
        port: 4000,
        healthcheck: { type: 'http', timeoutMs: 150, intervalMs: 25 },
      });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited),
        /was not ready after/,
      );
      assert.ok(Date.now() - startedAt < 2_000, 'a hanging fetch must be aborted by the configured timeout');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('resolves service references in http healthcheck urls', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    const port = await listen(server);
    try {
      const assignment = makeAssignment(port);
      const assignments: Assignments = { api: assignment };
      const service = makeService({
        port: 4000,
        healthcheck: { type: 'http', url: '${api.url}/health', timeoutMs: 5_000, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, assignments, assignment, notExited);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('passes command healthchecks that exit 0', async () => {
    const service = makeService({
      healthcheck: { type: 'command', command: 'exit 0', timeoutMs: 5_000, intervalMs: 25 },
    });
    await waitForServiceReady(makeConfig(), service, commandEnv, {}, undefined, notExited);
  });

  it('resolves service references in healthcheck commands', async () => {
    const assignment = makeAssignment(52001);
    const assignments: Assignments = { api: assignment };
    const service = makeService({
      healthcheck: { type: 'command', command: 'test "${api.port}" = "52001"', timeoutMs: 5_000, intervalMs: 25 },
    });
    await waitForServiceReady(makeConfig(), service, commandEnv, assignments, assignment, notExited);
  });

  it('enforces the overall timeout on a command healthcheck that never exits', async () => {
    const service = makeService({
      healthcheck: { type: 'command', command: 'sleep 10', timeoutMs: 150, intervalMs: 25 },
    });
    const startedAt = Date.now();
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, commandEnv, {}, undefined, notExited),
      /was not ready after/,
    );
    assert.ok(Date.now() - startedAt < 2_000, 'a hung healthcheck process group must be killed at timeout');
  });

  it('times out for command healthchecks that keep failing', async () => {
    const service = makeService({
      healthcheck: { type: 'command', command: 'exit 1', timeoutMs: 200, intervalMs: 25 },
    });
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, commandEnv, {}, undefined, notExited),
      /was not ready after/,
    );
  });

  it('rejects command healthchecks without a command', async () => {
    const service = makeService({
      healthcheck: { type: 'command', timeoutMs: 200, intervalMs: 25 },
    });
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, commandEnv, {}, undefined, notExited),
      /healthcheck command is missing/,
    );
  });
});
