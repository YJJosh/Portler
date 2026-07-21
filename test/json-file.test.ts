import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  CorruptStateFileError,
  readValidatedJsonFile,
  readValidatedJsonFileOrNull,
  writeJsonFile,
} from '../src/util/json-file.ts';

interface Shape {
  version: 1;
  value: string;
}

function isShape(value: unknown): value is Shape {
  return typeof value === 'object' && value !== null && (value as Shape).version === 1 && typeof (value as Shape).value === 'string';
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-json-'));
  file = path.join(dir, 'state.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writeJsonFile', () => {
  it('round-trips a value and creates parent directories', async () => {
    const nested = path.join(dir, 'a', 'b', 'state.json');
    await writeJsonFile(nested, { version: 1, value: 'x' });

    assert.deepEqual(await readValidatedJsonFile(nested, 'test file', isShape), { version: 1, value: 'x' });
  });

  it('leaves no temp files behind', async () => {
    await writeJsonFile(file, { version: 1, value: 'x' });
    assert.deepEqual(await fs.readdir(dir), ['state.json']);
  });

  it('replaces the file atomically, so a reader never sees a partial write', async () => {
    // The old implementation truncated the target and streamed into it: a reader
    // (or a crash) mid-write could observe an empty/half file. With a temp file +
    // rename, the target only ever holds a complete document — so a read
    // interleaved with a write always validates.
    await writeJsonFile(file, { version: 1, value: 'first' });

    const writes = Array.from({ length: 20 }, (_unused, index) =>
      writeJsonFile(file, { version: 1, value: `write-${index}` }),
    );
    const reads = Array.from({ length: 20 }, () => readValidatedJsonFile(file, 'test file', isShape));

    const [, ...readResults] = await Promise.all([Promise.all(writes), ...reads]);

    for (const result of readResults) {
      assert.ok(isShape(result), `a concurrent read observed a torn file: ${JSON.stringify(result)}`);
    }
  });
});

describe('readValidatedJsonFile', () => {
  it('returns null for a file that does not exist', async () => {
    assert.equal(await readValidatedJsonFile(file, 'test file', isShape), null);
  });

  it('raises an actionable error for malformed JSON', async () => {
    await fs.writeFile(file, '{ this is not json', 'utf8');

    await assert.rejects(readValidatedJsonFile(file, 'Portler state file', isShape), (error: unknown) => {
      assert.ok(error instanceof CorruptStateFileError);
      // The message must tell the user how to recover, not just "Unexpected token".
      assert.match((error as Error).message, /portler clean --force/);
      return true;
    });
  });

  it('raises for JSON that parses but has the wrong shape', async () => {
    await fs.writeFile(file, JSON.stringify({ version: 99 }), 'utf8');
    await assert.rejects(readValidatedJsonFile(file, 'Portler state file', isShape), CorruptStateFileError);
  });
});

describe('readValidatedJsonFileOrNull', () => {
  it('treats a corrupt file as absent so recovery paths can proceed', async () => {
    await fs.writeFile(file, 'garbage', 'utf8');
    assert.equal(await readValidatedJsonFileOrNull(file, 'Portler state file', isShape), null);
  });

  it('still returns a valid file', async () => {
    await writeJsonFile(file, { version: 1, value: 'x' });
    assert.deepEqual(await readValidatedJsonFileOrNull(file, 'test file', isShape), { version: 1, value: 'x' });
  });
});

describe('atomic writes leave no temp files behind', () => {
  it('cleans up the temp file when the rename fails', async () => {
    // The target is a non-empty DIRECTORY, so rename(temp, target) fails. Every
    // failure path after the temp file exists must remove it — otherwise a
    // .portler/ accumulates one `.pids.json.<pid>.<rand>.tmp` per failed write.
    const target = path.join(dir, 'occupied');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'child'), 'x', 'utf8');

    await assert.rejects(writeJsonFile(target, { version: 1, value: 'x' }));

    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `no temp files should survive a failed write, found: ${leftovers.join(', ')}`);
  });

  it('leaves nothing behind when the value cannot even be serialized', async () => {
    // A BigInt throws in JSON.stringify — before any temp file is opened. The
    // target must be untouched and no temp file may appear.
    const target = path.join(dir, 'never-written.json');

    await assert.rejects(writeJsonFile(target, { bad: 1n }));

    const leftovers = (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `no temp files should survive a failed write, found: ${leftovers.join(', ')}`);
    assert.equal(await fs.access(target).then(() => true, () => false), false);
  });
});
