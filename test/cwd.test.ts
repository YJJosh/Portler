import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertServiceCwd } from '../src/config/index.ts';
import type { PortlerConfig, ServiceConfig } from '../src/types/index.ts';

const cli = fileURLToPath(new URL('../bin/portler.ts', import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function project(yaml: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'portler-cwd-')));
  dirs.push(dir);
  const projectDir = path.join(dir, 'app');
  await fs.mkdir(projectDir);
  await fs.writeFile(path.join(projectDir, 'portler.yml'), yaml);
  return projectDir;
}

function portler(projectDir: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', cli, ...args], {
    cwd: projectDir,
    env: { ...process.env, PORTLER_GLOBAL_DIR: path.join(path.dirname(projectDir), 'global'), PORT: '45678' },
    encoding: 'utf8',
  });
}

describe('a service whose cwd is missing', () => {
  it('names the folder, not the shell', () => {
    const config = { projectDir: '/srv/app', filePath: '/srv/app/portler.yml' } as PortlerConfig;
    const service = { name: 'api', cwd: 'does-not-exist' } as ServiceConfig;
    assert.throws(
      () => assertServiceCwd(config, service),
      /service "api": cwd "does-not-exist" resolves to \/srv\/app\/does-not-exist, which does not exist\. cwd is relative to the project root \(\/srv\/app\)\.$/,
    );
    // With --file pointing elsewhere, the error says which folder cwd is relative to.
    assert.throws(
      () => assertServiceCwd({ ...config, filePath: '/srv/portler.yml' }, service),
      /relative to the project root \(\/srv\/app\), the folder Portler runs in, not to the folder of \/srv\/portler\.yml\.$/,
    );
  });

  it('is refused by up, setup and start before anything runs', async () => {
    const projectDir = await project(
      [
        'services:',
        '  svc:',
        '    cwd: does-not-exist',
        '    command: node -e "require(\'fs\').writeFileSync(\'../started\', \'x\'); setInterval(() => {}, 1000)"',
        '    setup: node -e "require(\'fs\').writeFileSync(\'../setup-ran\', \'x\')"',
        '',
      ].join('\n'),
    );
    await fs.writeFile(path.join(projectDir, 'file'), 'not a folder');

    for (const args of [['up', '-d'], ['setup', 'svc'], ['start', 'svc']]) {
      const result = portler(projectDir, ...args);
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /service "svc": cwd "does-not-exist" resolves to .*\/app\/does-not-exist, which does not exist/, args.join(' '));
      assert.doesNotMatch(result.stderr + result.stdout, /ENOENT|pid unknown/, args.join(' '));
    }
    await assert.rejects(fs.access(path.join(projectDir, 'started')));
    await assert.rejects(fs.access(path.join(projectDir, 'setup-ran')));
    assert.equal(portler(projectDir, 'ps').stdout.includes('svc'), false);

    // A file where the folder should be is named as such.
    await fs.writeFile(path.join(projectDir, 'portler.yml'), 'services:\n  svc:\n    cwd: file\n    command: node -e ""\n');
    const result = portler(projectDir, 'up', '-d');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /cwd "file" resolves to .*\/app\/file, which is not a directory/);
  });
});
