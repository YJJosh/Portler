/**
 * schema/portler.schema.json is written by hand. These checks keep it in step
 * with the loader: every key the loader reads is in the schema, and the
 * built-in presets use only service keys.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, it } from 'node:test';
import { parseYaml } from '../src/parse/yaml.ts';

interface SchemaNode {
  properties?: Record<string, unknown>;
  $defs?: Record<string, SchemaNode>;
}

const schema = JSON.parse(await fs.readFile(new URL('../schema/portler.schema.json', import.meta.url), 'utf8')) as SchemaNode;
const source = async (file: string) => fs.readFile(new URL(`../src/config/${file}`, import.meta.url), 'utf8');
const readKeys = (text: string, variable: string) => new Set([...text.matchAll(new RegExp(`\\b${variable}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g'))].map((match) => match[1]!));

describe('portler.yml JSON schema', () => {
  it('names every top-level key the loader reads', async () => {
    const text = (await Promise.all(['loader.ts', 'proxy.ts', 'volumes.ts'].map(source))).join('\n');
    const keys = readKeys(text, 'root');
    assert.ok(keys.size > 10);
    for (const key of keys) assert.ok(schema.properties?.[key], `top-level "${key}" is missing from the schema`);
  });

  it('names every service key the loader reads', async () => {
    const text = (await Promise.all(['loader.ts', 'docker.ts', 'k8s.ts', 'presets.ts'].map(source))).join('\n');
    const service = schema.$defs!.service!.properties!;
    const keys = readKeys(text, 'rawService');
    assert.ok(keys.has('use') && keys.has('exports'));
    for (const key of keys) assert.ok(service[key], `service key "${key}" is missing from the schema`);
  });

  it('describes the built-in presets as services', async () => {
    const service = schema.$defs!.service!.properties!;
    const dir = new URL('../presets/', import.meta.url);
    for (const file of await fs.readdir(dir)) {
      const preset = parseYaml(await fs.readFile(new URL(file, dir), 'utf8'));
      const { versions, ...keys } = preset as { versions: Record<string, Record<string, unknown> | null> };
      const versionKeys = Object.values(versions).flatMap((override) => Object.keys(override ?? {}));
      for (const key of [...Object.keys(keys), ...versionKeys]) assert.ok(service[key], `${file}: "${key}" is not a service key`);
    }
  });
});
