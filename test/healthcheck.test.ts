import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { normalizeHealthcheck } from '../src/config/healthcheck.ts';
import { DEFAULT_HEALTHCHECK_INTERVAL_MS, DEFAULT_HEALTHCHECK_TIMEOUT_MS } from '../src/constants.ts';
import { DOCKER_TCP_HOLD_MS, isTcpReady, portlerErrorsInLog, waitForServiceReady } from '../src/readiness/index.ts';
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

  it('does not count a Docker port as ready while the proxy closes every connection', async () => {
    // Docker's port proxy accepts on the published port and closes at once
    // while nothing listens inside the container.
    const proxy = net.createServer((socket) => socket.destroy());
    const port = await listen(proxy);
    try {
      assert.equal(await isTcpReady('127.0.0.1', port), true, 'a plain connect is fooled by the proxy');
      assert.equal(await isTcpReady('127.0.0.1', port, 1_000, 100), false);
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 300, intervalMs: 25 },
      });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited, DOCKER_TCP_HOLD_MS),
        /service "api" was not ready after/,
      );
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  it('passes a Docker tcp check once a connection stays open', async () => {
    const server = net.createServer((socket) => socket.write('ready\n'));
    const port = await listen(server);
    try {
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited, DOCKER_TCP_HOLD_MS);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('counts a Docker port as ready when the peer answers and hangs up', async () => {
    // A banner-then-close protocol (an SMTP greeting, a server that redirects
    // and closes) is a real listener. Docker's proxy never sends application
    // data, so bytes from the peer settle the probe before the hold ends.
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.end('220 ready\r\n');
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      assert.equal(await isTcpReady('127.0.0.1', port, 1_000, DOCKER_TCP_HOLD_MS), true);
      assert.ok(Date.now() - startedAt < DOCKER_TCP_HOLD_MS, 'the data settled it before the hold would have ended');
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 1_000, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited, DOCKER_TCP_HOLD_MS);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('lets an exit during the probe win over a late "ready"', async () => {
    // The hold keeps ticking against a port whose process died meanwhile
    // (Docker's proxy keeps accepting). The exit has to win.
    const server = net.createServer(() => {});
    const port = await listen(server);
    try {
      let exited = false;
      setTimeout(() => {
        exited = true;
      }, 50);
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 },
      });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), () => exited, DOCKER_TCP_HOLD_MS),
        /exited before it became ready/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('names the detached log file instead of "the log lines above" when one is given', async () => {
    const port = await findFreePort();
    const service = makeService({ port: 4000, healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 } });
    await assert.rejects(
      waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), () => true, 0, '/proj/.portler/logs/api.log'),
      (error: Error) => /Check \/proj\/\.portler\/logs\/api\.log \(or "portler logs api"\) for the cause/.test(error.message) && !/above/.test(error.message),
    );
  });

  it("puts Portler's own refusal from a detached log into the error", async () => {
    // The launch shell refuses a container name another project owns and
    // exits before Docker starts anything; in a detached run that line is
    // only in the log, so the terminal used to say just "exited".
    const dir = mkdtempSync(path.join(os.tmpdir(), 'portler-exited-log-'));
    try {
      const logFile = path.join(dir, 'db.log');
      writeFileSync(
        logFile,
        'Unable to find image locally\n' +
          '[portler] error: container "portler-shop--db" exists but is not managed by this project; refusing to remove it. ' +
          'Rename it, remove it yourself, or set container_name.\n',
      );
      const port = await findFreePort();
      const service = makeService({ port: 4000, healthcheck: { type: 'tcp', timeoutMs: 5_000, intervalMs: 25 } });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), () => true, 0, logFile),
        (error: Error) => {
          assert.match(error.message, /^service "api" exited before it became ready: container "portler-shop--db" exists but is not managed by this project/);
          assert.match(error.message, new RegExp(`The full output is in ${logFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(or "portler logs api"\\)`));
          assert.doesNotMatch(error.message, /\[portler\] error:/, 'the prefix is not repeated inside the message');
          return true;
        },
      );

      // A log without a refusal of Portler's keeps the plain hint.
      writeFileSync(logFile, 'panic: listen tcp: address already in use\n');
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), () => true, 0, logFile),
        /exited before it became ready\. Check .*db\.log \(or "portler logs api"\) for the cause/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a detached log's refusals from its last MiB, in chunks", () => {
    // The launch shell builds first and checks names afterwards, so a refusal
    // follows any build output. Only the last MiB is read, 64 KiB at a time; a
    // line or a character split across two reads still counts.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'portler-exited-scan-'));
    try {
      const logFile = path.join(dir, 'api.log');
      const chunk = 64 * 1024;

      // A refusal that straddles the first chunk boundary with a two-byte
      // character split across it, and a CRLF ending. The filler ends at byte
      // chunk - 20, the 17-byte prefix and "ab" fill the rest, and "é" takes
      // the last byte of the first read and the first of the second.
      const filler = `${'a'.repeat(chunk - 21)}\n`;
      writeFileSync(logFile, `${filler}[portler] error: abé network "portler-shop" is someone else's\r\nbuild output\n`);
      assert.deepEqual(portlerErrorsInLog(logFile), [`abé network "portler-shop" is someone else's`]);

      // Several megabytes of build output, then four refusals: the last three
      // are reported, in order.
      const noise = `${'step 1/9 : RUN pnpm install --frozen-lockfile '.repeat(20)}\n`.repeat(4_000);
      writeFileSync(
        logFile,
        `${noise}${noise}[portler] error: one\n[portler] error: two\n[portler] error:   \n[portler] error: three\nbuild output\n[portler] error: four\n`,
      );
      assert.deepEqual(portlerErrorsInLog(logFile), ['two', 'three', 'four']);

      // A refusal before the last MiB is not read.
      writeFileSync(logFile, `[portler] error: early\n${noise}`);
      assert.deepEqual(portlerErrorsInLog(logFile), []);

      // The last MiB below starts at the "[" of a line that began earlier, so
      // the rest of that line is not taken for a refusal; when the byte before
      // the window is a newline, the line is whole and counts.
      const tail = 1024 * 1024;
      const window = `[portler] error: fake\n${'b'.repeat(tail - 45)}\n[portler] error: real\n`;
      assert.equal(Buffer.byteLength(window), tail);
      writeFileSync(logFile, `zzz${window}`);
      assert.deepEqual(portlerErrorsInLog(logFile), ['real']);
      writeFileSync(logFile, `zzz\n${window}`);
      assert.deepEqual(portlerErrorsInLog(logFile), ['fake', 'real']);

      // A refusal that runs on for hundreds of kilobytes is cut, and says so.
      writeFileSync(logFile, `[portler] error: ${'x'.repeat(300 * 1024)}\n[portler] error: next\n`);
      const [long, next] = portlerErrorsInLog(logFile);
      assert.equal(long, `${'x'.repeat(500)}…`);
      assert.equal(next, 'next');

      // A last line without a newline counts; a missing log has none.
      writeFileSync(logFile, 'boot\n[portler] error: volume is foreign');
      assert.deepEqual(portlerErrorsInLog(logFile), ['volume is foreign']);
      assert.deepEqual(portlerErrorsInLog(path.join(dir, 'missing.log')), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads no more of a detached log than it held when the scan started', { skip: process.platform === 'win32' }, () => {
    // A process the launch shell left behind can keep appending to the log
    // while it is scanned. /dev/zero stands in for a file that never ends:
    // its size reads as 0 and a read never reaches end-of-file.
    assert.deepEqual(portlerErrorsInLog('/dev/zero'), []);
  });

  it('does not let the Docker hold run past the attempt deadline', async () => {
    // A silent peer has to stay open for the whole hold. A connect that lands
    // with less than the hold window left cannot prove that before the
    // deadline, so it is not ready, and it says so at the deadline instead of
    // after the hold would have ended.
    const server = net.createServer((socket) => {
      // The probe may have destroyed its end already; a reset here is expected.
      socket.on('error', () => {});
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      assert.equal(await isTcpReady('127.0.0.1', port, 25, 200), false);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 150, `answered after ${elapsed}ms, the hold would have ended at 200ms`);
      assert.equal(await isTcpReady('127.0.0.1', port, 1_000, 100), true, 'with room for the hold the same port is ready');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('lets a peer that answers inside a short attempt count as ready', async () => {
    // The data listener goes on before the short-window decision: a container
    // whose app answers at once is ready even when the attempt leaves less than
    // the hold, so a healthcheck timeout under the hold is only hopeless for a
    // listener that stays silent.
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.write('ready\n');
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      assert.equal(await isTcpReady('127.0.0.1', port, 25, 200), true);
      assert.ok(Date.now() - startedAt < 150, 'the answer settled it inside the 25 ms window');
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 100, intervalMs: 25 },
      });
      await waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited, DOCKER_TCP_HOLD_MS);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('still reports a silent container not ready when the healthcheck timeout is under the hold', async () => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
    });
    const port = await listen(server);
    try {
      const service = makeService({
        port: 4000,
        docker: { image: 'app', containerName: 'portler-api', volumes: [], env: {} },
        healthcheck: { type: 'tcp', timeoutMs: 100, intervalMs: 25 },
      });
      await assert.rejects(
        waitForServiceReady(makeConfig(), service, {}, {}, makeAssignment(port), notExited, DOCKER_TCP_HOLD_MS),
        /not ready/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rechecks the deadline when the hold timer fires', async () => {
    // A blocked event loop can delay the hold timer past the attempt deadline.
    // A silent peer whose hold ended late has proved nothing in time, so the
    // answer is still "not ready". The block lands after the connect (loopback
    // connects within a few ms) and before the 200 ms hold would have ended.
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      const probe = isTcpReady('127.0.0.1', port, 300, 200);
      setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400), 50);
      assert.equal(await probe, false);
      assert.ok(Date.now() - startedAt >= 300, 'the answer came after the deadline the block ran through');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('passes an http check for 2xx and 3xx by default, and for listed statuses with accept', async () => {
    // A 404 says the server is up but the route is missing, which is what a
    // misconfigured path looks like, so it is not ready unless the config says so.
    let status = 302;
    const server = http.createServer((_request, response) => {
      response.statusCode = status;
      if (status === 302) response.setHeader('location', 'http://127.0.0.1/elsewhere');
      response.end();
    });
    const port = await listen(server);
    const check = (accept?: number[]) =>
      waitForServiceReady(
        makeConfig(),
        makeService({ port: 4000, healthcheck: { type: 'http', timeoutMs: 300, intervalMs: 25, ...(accept ? { accept } : {}) } }),
        {},
        {},
        makeAssignment(port),
        notExited,
      );
    try {
      await check();
      status = 404;
      await assert.rejects(check(), /not ready/);
      await check([200, 404]);
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

describe('healthcheck accept', () => {
  it('parses a list or a single status and rejects anything that is not an http status', () => {
    assert.deepEqual(normalizeHealthcheck({ url: 'http://x', accept: [200, 404] }, 'api')?.accept, [200, 404]);
    assert.deepEqual(normalizeHealthcheck({ url: 'http://x', accept: 204 }, 'api')?.accept, [204]);
    assert.equal(normalizeHealthcheck({ url: 'http://x' }, 'api')?.accept, undefined);
    for (const bad of [[], [99], [600], ['ok'], [200.5]]) {
      assert.throws(() => normalizeHealthcheck({ url: 'http://x', accept: bad }, 'api'), /accept must/);
    }
  });
});
