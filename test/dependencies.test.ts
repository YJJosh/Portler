import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeDependsOn } from '../src/config/dependencies.ts';
import { dependencyLevels, expandAndOrderServices, selectServiceNames } from '../src/cli/services.ts';
import type { DependencyConfig, PortlerConfig, ServiceConfig } from '../src/types/index.ts';

describe('normalizeDependsOn', () => {
  it('returns [] for undefined/null', () => {
    assert.deepEqual(normalizeDependsOn(undefined, 'api'), []);
    assert.deepEqual(normalizeDependsOn(null, 'api'), []);
  });

  it('normalizes a single string to a ready dependency', () => {
    assert.deepEqual(normalizeDependsOn('postgres', 'api'), [{ service: 'postgres', condition: 'ready' }]);
  });

  it('normalizes string arrays to ready dependencies', () => {
    assert.deepEqual(normalizeDependsOn(['postgres', 'redis'], 'api'), [
      { service: 'postgres', condition: 'ready' },
      { service: 'redis', condition: 'ready' },
    ]);
  });

  it('rejects arrays with non-string items', () => {
    assert.throws(() => normalizeDependsOn(['postgres', 42], 'api'), /must only contain service names/);
  });

  it('normalizes object form with condition strings', () => {
    assert.deepEqual(normalizeDependsOn({ postgres: 'started', redis: 'ready' }, 'api'), [
      { service: 'postgres', condition: 'started' },
      { service: 'redis', condition: 'ready' },
    ]);
  });

  it('maps compose-style aliases healthy/service_healthy to ready', () => {
    assert.deepEqual(normalizeDependsOn({ a: 'healthy', b: 'service_healthy' }, 'api'), [
      { service: 'a', condition: 'ready' },
      { service: 'b', condition: 'ready' },
    ]);
  });

  it('defaults null/true/empty-object entries to ready', () => {
    assert.deepEqual(normalizeDependsOn({ a: null, b: true, c: {} }, 'api'), [
      { service: 'a', condition: 'ready' },
      { service: 'b', condition: 'ready' },
      { service: 'c', condition: 'ready' },
    ]);
  });

  it('reads condition from nested objects', () => {
    assert.deepEqual(normalizeDependsOn({ a: { condition: 'started' } }, 'api'), [
      { service: 'a', condition: 'started' },
    ]);
  });

  it('rejects unknown conditions', () => {
    assert.throws(() => normalizeDependsOn({ a: 'sideways' }, 'api'), /condition must be started or ready/);
  });

  it('rejects invalid shapes', () => {
    assert.throws(() => normalizeDependsOn(42, 'api'), /must be a string, array, or object/);
    assert.throws(() => normalizeDependsOn({ a: 42 }, 'api'), /must be a string or object/);
  });
});

function makeService(name: string, dependsOn: DependencyConfig[], port?: number): ServiceConfig {
  return {
    name,
    cwd: '.',
    port,
    portEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    preferDeclaredPort: false,
    dependsOn,
  };
}

function ready(service: string): DependencyConfig {
  return { service, condition: 'ready' };
}

function makeConfig(services: ServiceConfig[]): PortlerConfig {
  return {
    filePath: '/project/portler.yml',
    projectDir: '/project',
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: '/project',
    volumes: [],
    k8sNamespace: 'portler-test',
    services: Object.fromEntries(services.map((service) => [service.name, service])),
  };
}

describe('expandAndOrderServices', () => {
  const config = makeConfig([
    makeService('frontend', [ready('backend')]),
    makeService('backend', [ready('postgres'), ready('redis')]),
    makeService('postgres', []),
    makeService('redis', []),
  ]);

  it('orders all services dependency-first by default', () => {
    const order = expandAndOrderServices(config, []);
    assert.equal(order.length, 4);
    assert.ok(order.indexOf('postgres') < order.indexOf('backend'));
    assert.ok(order.indexOf('redis') < order.indexOf('backend'));
    assert.ok(order.indexOf('backend') < order.indexOf('frontend'));
  });

  it('expands a requested root to include its transitive dependencies', () => {
    assert.deepEqual(expandAndOrderServices(config, ['backend']), ['postgres', 'redis', 'backend']);
  });

  it('does not include unrelated services', () => {
    assert.deepEqual(expandAndOrderServices(config, ['redis']), ['redis']);
  });

  it('throws on unknown requested services', () => {
    assert.throws(() => expandAndOrderServices(config, ['nope']), /unknown service "nope"/);
  });

  it('throws on dependency cycles', () => {
    const cyclic = makeConfig([makeService('a', [ready('b')]), makeService('b', [ready('a')])]);
    assert.throws(() => expandAndOrderServices(cyclic, []), /dependency cycle includes service/);
  });

  it('visits shared dependencies only once', () => {
    const diamond = makeConfig([
      makeService('top', [ready('left'), ready('right')]),
      makeService('left', [ready('base')]),
      makeService('right', [ready('base')]),
      makeService('base', []),
    ]);
    assert.deepEqual(expandAndOrderServices(diamond, ['top']), ['base', 'left', 'right', 'top']);
  });
});

describe('dependencyLevels', () => {
  it('groups independent services into concurrent levels', () => {
    const config = makeConfig([
      makeService('frontend', [ready('backend')]),
      makeService('backend', [ready('postgres'), ready('redis')]),
      makeService('postgres', []),
      makeService('redis', []),
    ]);
    const order = expandAndOrderServices(config, []);
    assert.deepEqual(dependencyLevels(config, order), [['postgres', 'redis'], ['backend'], ['frontend']]);
  });

  it('ignores dependencies outside the selected set', () => {
    const config = makeConfig([makeService('api', [ready('db')]), makeService('db', [])]);
    assert.deepEqual(dependencyLevels(config, ['api']), [['api']]);
  });
});

describe('selectServiceNames', () => {
  const config = makeConfig([makeService('a', []), makeService('b', [])]);

  it('defaults to all services', () => {
    assert.deepEqual(selectServiceNames(config, []), ['a', 'b']);
  });

  it('validates requested names', () => {
    assert.deepEqual(selectServiceNames(config, ['b']), ['b']);
    assert.throws(() => selectServiceNames(config, ['c']), /unknown service "c"/);
  });
});
