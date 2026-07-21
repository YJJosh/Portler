import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseYaml } from '../src/parse/yaml.ts';

describe('parseYaml', () => {
  it('parses nested mappings by indentation', () => {
    const text = ['services:', '  api:', '    command: npm run dev', '    port: 4000'].join('\n');
    assert.deepEqual(parseYaml(text), {
      services: { api: { command: 'npm run dev', port: 4000 } },
    });
  });

  it('parses scalar types', () => {
    const text = [
      'a: true',
      'b: false',
      'c: null',
      'd: ~',
      'e: 42',
      'f: -7',
      'g: 3.14',
      'h: plain string',
      'i: ""',
    ].join('\n');
    assert.deepEqual(parseYaml(text), {
      a: true,
      b: false,
      c: null,
      d: null,
      e: 42,
      f: -7,
      g: 3.14,
      h: 'plain string',
      i: '',
    });
  });

  it('parses quoted strings, keeping colons and hashes', () => {
    const text = ['a: "postgres://user:pass@host:5432/db"', "b: 'it''s quoted'", 'c: "with # hash"'].join('\n');
    assert.deepEqual(parseYaml(text), {
      a: 'postgres://user:pass@host:5432/db',
      b: "it's quoted",
      c: 'with # hash',
    });
  });

  it('parses unquoted values containing colons (URL-style)', () => {
    assert.deepEqual(parseYaml('url: http://localhost:3000'), { url: 'http://localhost:3000' });
  });

  it('strips comments (full-line and trailing)', () => {
    const text = ['# heading', 'a: 1 # trailing', 'b: "quoted # kept"'].join('\n');
    assert.deepEqual(parseYaml(text), { a: 1, b: 'quoted # kept' });
  });

  it('parses block sequences of scalars', () => {
    const text = ['depends_on:', '  - postgres', '  - redis'].join('\n');
    assert.deepEqual(parseYaml(text), { depends_on: ['postgres', 'redis'] });
  });

  it('parses inline arrays and objects', () => {
    const text = ['arr: [1, two, "three, four"]', 'obj: {a: 1, b: [2, 3]}', 'empty_arr: []', 'empty_obj: {}'].join('\n');
    assert.deepEqual(parseYaml(text), {
      arr: [1, 'two', 'three, four'],
      obj: { a: 1, b: [2, 3] },
      empty_arr: [],
      empty_obj: {},
    });
  });

  it('parses a bare key as null when nothing nests under it', () => {
    assert.deepEqual(parseYaml('key:'), { key: null });
  });

  it('handles dedenting back to shallower levels', () => {
    const text = ['a:', '  b:', '    c: 1', '  d: 2', 'e: 3'].join('\n');
    assert.deepEqual(parseYaml(text), { a: { b: { c: 1 }, d: 2 }, e: 3 });
  });

  it('ignores blank lines and a UTF-8 BOM', () => {
    assert.deepEqual(parseYaml('﻿a: 1\r\n\r\nb: 2\r\n'), { a: 1, b: 2 });
  });

  it('rejects tab indentation', () => {
    assert.throws(() => parseYaml('a:\n\tb: 1', 'portler.yml'), /portler\.yml:2: tab character used for indentation/);
  });

  it('rejects lines without a key/value separator', () => {
    assert.throws(() => parseYaml('just some text'), /the top level of the file must be a mapping of "key: value" pairs/);
  });

  it('rejects empty keys', () => {
    assert.throws(() => parseYaml(': value'), /empty keys are not supported/);
  });

  it('rejects array items that are not nested under a key', () => {
    const text = ['key: value', '- item'].join('\n');
    assert.throws(() => parseYaml(text), /unexpected "-" sequence item inside a mapping/);
  });

  it('rejects mapping entries mixed into an array block', () => {
    const text = ['key:', '  - item', '  nested: 1'].join('\n');
    assert.throws(() => parseYaml(text), /bad indentation/);
  });

  it('parses a realistic portler.yml document', () => {
    const text = [
      'use_env: .env',
      '',
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    port: 5432',
      '    env:',
      '      POSTGRES_USER: app',
      '    volumes:',
      "      - '@postgres-data:/var/lib/postgresql/data'",
      '  backend:',
      '    command: npm run dev',
      '    port: 4000',
      '    depends_on:',
      '      - postgres',
      '    env:',
      '      DATABASE_URL: postgres://app:app@localhost:${postgres.port}/app',
    ].join('\n');

    assert.deepEqual(parseYaml(text), {
      use_env: '.env',
      services: {
        postgres: {
          image: 'postgres:16-alpine',
          port: 5432,
          env: { POSTGRES_USER: 'app' },
          volumes: ['@postgres-data:/var/lib/postgresql/data'],
        },
        backend: {
          command: 'npm run dev',
          port: 4000,
          depends_on: ['postgres'],
          env: { DATABASE_URL: 'postgres://app:app@localhost:${postgres.port}/app' },
        },
      },
    });
  });
});
