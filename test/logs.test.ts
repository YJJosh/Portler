import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { commandLogs } from '../src/cli/commands/logs.ts';
import { loadConfig } from '../src/config/index.ts';
import { serviceLogPath } from '../src/process/logs.ts';
import { spawnService } from '../src/process/spawn.ts';

let projectDir: string;
let previousCwd: string;
let previousGlobalDir: string | undefined;

beforeEach(async () => {
  previousCwd = process.cwd();
  previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
  projectDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-logs-')));
  process.env.PORTLER_GLOBAL_DIR = path.join(projectDir, 'global');
  process.chdir(projectDir);
  await fs.writeFile('portler.yml', 'services:\n  api:\n    command: printf "$MARK"\n  db:\n    image: alpine:3.20\n');
  await fs.mkdir(path.dirname(serviceLogPath(projectDir, 'api')), { recursive: true });
});

afterEach(async () => {
  process.chdir(previousCwd);
  if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
  else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
  await fs.rm(projectDir, { recursive: true, force: true });
});

for (const serviceName of ['api', 'db']) {
  it(`gives each detached ${serviceName === 'api' ? 'local' : 'Docker'} service start a new log generation`, async () => {
    // Docker uses the same capture path; fake it without contacting a daemon.
    await fs.writeFile('docker', `#!/bin/sh
case "$1" in
  network) printf '%s\\n' "$PWD" ;;
  inspect) exit 1 ;;
  run) printf '%s' "$MARK" ;;
esac
`, { mode: 0o755 });
    const config = await loadConfig(projectDir);
    const service = config.services[serviceName]!;
    const logPath = serviceLogPath(projectDir, serviceName);
    const start = async (mark: string) => {
      const child = spawnService(config, service, { PATH: `${projectDir}:${process.env.PATH}`, MARK: mark }, new Set(), undefined, {}, false, logPath);
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
    };
    await start('AAA\n');
    const first = await fs.stat(logPath);
    // Keep the old inode alive: this also verifies existing writer descriptors
    // cannot accidentally append to the new run's log.
    const old = await fs.open(logPath, 'a');
    try {
      await start('BBB\n');
      const second = await fs.stat(logPath);
      assert.notEqual(second.ino, first.ino);
      assert.equal(second.size, first.size);
      await old.write('old run\n');
      assert.equal(await fs.readFile(logPath, 'utf8'), 'BBB\n');
      assert.deepEqual((await fs.readdir(path.dirname(logPath))).filter((name) => name.endsWith('.tmp')), []);
    } finally {
      await old.close();
    }
  });
}

it('follows equal-length and larger replacements made entirely between polls, and in-place shrink', async (t) => {
  const logPath = serviceLogPath(projectDir, 'api');
  await fs.writeFile(logPath, 'AAA\n');
  let output = '';
  t.mock.method(process.stdout, 'write', (chunk: string | Buffer) => {
    output += chunk.toString();
    return true;
  });

  // Each registration means all file I/O for that poll has finished. Hold the
  // sleep unresolved while replacing the log, then explicitly run the next
  // poll. No wall-clock race can expose an intermediate truncation to it.
  let release: () => void;
  let polled: () => void;
  let pollFinished = new Promise<void>((resolve) => { polled = resolve; });
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    assert.equal(ms, 250);
    release = callback;
    polled();
    return {};
  });
  const errors: unknown[] = [];
  const oldListeners = process.stdout.rawListeners('error');
  void commandLogs(parseArgs(['api', '--follow'], 'logs')).catch((error) => {
    errors.push(error);
    polled();
  });
  const nextPoll = async () => {
    pollFinished = new Promise<void>((resolve) => { polled = resolve; });
    release();
    await pollFinished;
    assert.deepEqual(errors, []);
  };
  try {
    await pollFinished;
    assert.equal(String(output), '[api] AAA\n');
    await fs.writeFile(`${logPath}.new`, 'BBB\n');
    await fs.rename(`${logPath}.new`, logPath);
    await nextPoll();
    assert.equal(String(output), '[api] AAA\n[api] BBB\n');

    await fs.writeFile(`${logPath}.new`, 'CCC\nextra\n');
    await fs.rename(`${logPath}.new`, logPath);
    await nextPoll();
    assert.equal(String(output), '[api] AAA\n[api] BBB\n[api] CCC\n[api] extra\n');

    await fs.writeFile(logPath, 'D\n');
    await nextPoll();
    assert.ok(output.endsWith('[api] D\n'));
    await fs.appendFile(logPath, 'tail');
    await nextPoll();
    await fs.writeFile(`${logPath}.new`, 'EEE\n');
    await fs.rename(`${logPath}.new`, logPath);
    await nextPoll();
    assert.ok(output.endsWith('[api] D\n[api] tail\n[api] EEE\n'));
  } finally {
    // The follower is suspended in a mocked sleep, with no timer or open fd.
    for (const listener of process.stdout.rawListeners('error')) {
      if (!oldListeners.includes(listener)) process.stdout.removeListener('error', listener as (error: Error) => void);
    }
  }
});
