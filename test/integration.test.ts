import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { expandAndOrderServices } from '../src/cli/services.ts';
import { loadBaseEnv, loadConfig } from '../src/config/loader.ts';
import { buildGeneratedEnv } from '../src/env/generate.ts';
import { buildPrintableEnv, buildServiceEnv } from '../src/env/service.ts';
import { parseDotEnv } from '../src/parse/dotenv.ts';
import { allocateAssignments, releasePorts } from '../src/ports/allocate.ts';
import { readState, runtimeEnvPath, writeRuntimeEnv, writeState } from '../src/state/index.ts';

const PORTLER_YML = [
  'use_env: .env',
  '',
  'services:',
  '  postgres:',
  '    image: postgres:16-alpine',
  '    port: 5432',
  '    env:',
  '      POSTGRES_USER: app',
  '',
  '  backend:',
  '    command: npm run dev',
  '    port: 4000',
  '    port_env: PORT',
  '    depends_on:',
  '      - postgres',
  '    env:',
  '      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app',
  '      CORS_ALLOWED_ORIGIN: frontend.url',
  '',
  '  frontend:',
  '    command: npm run dev',
  '    port: 3000',
  '    port_env: PORT',
  '    depends_on:',
  '      - backend',
  '    env:',
  '      VITE_API_URL: backend.url',
  '',
].join('\n');

describe('integration: config load -> port allocate -> env generate', () => {
  let previousGlobalDir: string | undefined;
  let globalDir: string;
  let projectDir: string;

  before(async () => {
    previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
    globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-global-'));
    process.env.PORTLER_GLOBAL_DIR = globalDir;

    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-app-'));
    await fs.writeFile(path.join(projectDir, 'portler.yml'), PORTLER_YML, 'utf8');
    await fs.writeFile(path.join(projectDir, '.env'), 'APP_SECRET=from-dotenv\n', 'utf8');
  });

  after(async () => {
    if (previousGlobalDir === undefined) {
      delete process.env.PORTLER_GLOBAL_DIR;
    } else {
      process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
    }
    await fs.rm(globalDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('runs the full local flow with stable port reuse', async () => {
    // 1. Load and normalize the config.
    const config = await loadConfig(projectDir);
    assert.deepEqual(Object.keys(config.services), ['postgres', 'backend', 'frontend']);
    assert.ok(config.services.postgres?.docker, 'postgres should be a Docker service');
    assert.equal(config.services.backend?.docker, undefined);

    // 2. Dependency ordering.
    assert.deepEqual(expandAndOrderServices(config, []), ['postgres', 'backend', 'frontend']);

    // 3. Base env from .env.
    const baseEnv = await loadBaseEnv(config);
    assert.deepEqual(baseEnv, { APP_SECRET: 'from-dotenv' });

    // 4. Port allocation.
    const serviceNames = ['postgres', 'backend', 'frontend'];
    const assignments = await allocateAssignments(config, null, serviceNames, new Set());
    const ports = serviceNames.map((name) => assignments[name]!.port);
    assert.equal(new Set(ports).size, 3, 'ports must be unique');
    for (const port of ports) {
      assert.ok(port >= config.portRange.start && port <= config.portRange.end, `port ${port} out of range`);
    }

    // 5. Generated PORTLER_* env.
    const generatedEnv = buildGeneratedEnv(assignments);
    assert.equal(generatedEnv.PORTLER_SERVICE_NAMES, 'backend,frontend,postgres');
    assert.equal(generatedEnv.PORTLER_BACKEND_PORT, String(assignments.backend!.port));
    assert.equal(generatedEnv.PORTLER_POSTGRES_CONTAINER, config.services.postgres!.docker!.containerName);

    // 6. Service env resolution for the backend.
    const backend = config.services.backend!;
    const { env, explicitKeys } = buildServiceEnv(config, backend, baseEnv, generatedEnv, assignments);
    assert.equal(env.DATABASE_URL, `postgres://app:app@localhost:${assignments.postgres!.port}/app`);
    assert.equal(env.CORS_ALLOWED_ORIGIN, assignments.frontend!.url);
    assert.equal(env.PORT, String(assignments.backend!.port));
    assert.equal(env.APP_SECRET, 'from-dotenv');
    assert.equal(env.PORTLER_SERVICE_NAME, 'backend');
    assert.ok(explicitKeys.has('DATABASE_URL'));
    assert.ok(explicitKeys.has('APP_SECRET'));

    // The postgres Docker service sees its internal container port.
    const postgres = config.services.postgres!;
    const postgresEnv = buildServiceEnv(config, postgres, baseEnv, generatedEnv, assignments).env;
    assert.equal(postgresEnv.POSTGRES_USER, 'app');

    // 7. State roundtrip.
    await writeState(projectDir, assignments);
    const state = await readState(projectDir);
    assert.ok(state);
    assert.equal(state.project, projectDir);
    assert.equal(state.services.backend?.port, assignments.backend!.port);

    // A state file copied from another checkout is not this project's cache.
    await fs.writeFile(
      path.join(projectDir, '.portler', 'state.json'),
      JSON.stringify({ ...state, project: '/some/other/checkout' }),
      'utf8',
    );
    await assert.rejects(readState(projectDir), /invalid Portler state file/);
    await writeState(projectDir, assignments);

    // 8. Runtime env file roundtrip.
    const printable = buildPrintableEnv(config, backend, generatedEnv, assignments);
    await writeRuntimeEnv(projectDir, printable);
    const runtimeEnv = parseDotEnv(await fs.readFile(runtimeEnvPath(projectDir), 'utf8'));
    assert.equal(runtimeEnv.DATABASE_URL, env.DATABASE_URL);
    assert.equal(runtimeEnv.PORTLER_BACKEND_URL, assignments.backend!.url);

    // 9. Re-allocation with the saved state reuses the same ports.
    const second = await allocateAssignments(config, state, serviceNames, new Set());
    for (const name of serviceNames) {
      assert.equal(second[name]!.port, assignments[name]!.port, `port for ${name} should be stable`);
    }

    // 10. Releasing removes this project's registry reservations.
    await releasePorts(projectDir);
    const registryText = await fs.readFile(path.join(globalDir, 'ports.json'), 'utf8');
    assert.deepEqual(JSON.parse(registryText).ports, {});
  });
});
