import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatDotEnv, parseDotEnv } from '../src/parse/dotenv.ts';

describe('parseDotEnv', () => {
  it('parses simple KEY=value pairs', () => {
    assert.deepEqual(parseDotEnv('FOO=bar\nBAZ=qux'), { FOO: 'bar', BAZ: 'qux' });
  });

  it('skips blank lines and full-line comments', () => {
    const text = '\n# a comment\n   \nFOO=bar\n  # indented comment\n';
    assert.deepEqual(parseDotEnv(text), { FOO: 'bar' });
  });

  it('supports the export prefix', () => {
    assert.deepEqual(parseDotEnv('export FOO=bar'), { FOO: 'bar' });
  });

  it('strips unquoted trailing comments', () => {
    assert.deepEqual(parseDotEnv('FOO=bar # comment'), { FOO: 'bar' });
  });

  it('does not treat # inside quotes as a comment', () => {
    assert.deepEqual(parseDotEnv('FOO="bar # not a comment"'), { FOO: 'bar # not a comment' });
  });

  it('does not strip # without preceding whitespace', () => {
    assert.deepEqual(parseDotEnv('FOO=bar#baz'), { FOO: 'bar#baz' });
  });

  it('unquotes double-quoted values with escapes', () => {
    assert.deepEqual(parseDotEnv('FOO="line1\\nline2 \\"quoted\\""'), { FOO: 'line1\nline2 "quoted"' });
  });

  it('treats single-quoted values literally', () => {
    assert.deepEqual(parseDotEnv("FOO='a \\n literal'"), { FOO: 'a \\n literal' });
  });

  it('preserves = characters inside the value', () => {
    assert.deepEqual(parseDotEnv('FOO=a=b=c'), { FOO: 'a=b=c' });
  });

  it('trims whitespace around keys and values', () => {
    assert.deepEqual(parseDotEnv('  FOO  =  bar  '), { FOO: 'bar' });
  });

  it('handles a UTF-8 BOM and CRLF line endings', () => {
    assert.deepEqual(parseDotEnv('﻿FOO=bar\r\nBAZ=qux\r\n'), { FOO: 'bar', BAZ: 'qux' });
  });

  it('keeps empty values as empty strings', () => {
    assert.deepEqual(parseDotEnv('FOO='), { FOO: '' });
  });

  it('later keys win over earlier duplicates', () => {
    assert.deepEqual(parseDotEnv('FOO=first\nFOO=second'), { FOO: 'second' });
  });

  it('throws with file:line for lines without =', () => {
    assert.throws(() => parseDotEnv('FOO=bar\nnot a pair', 'custom.env'), /custom\.env:2: expected KEY=value/);
  });

  it('throws for invalid env keys', () => {
    assert.throws(() => parseDotEnv('1BAD=x'), /invalid env key "1BAD"/);
    assert.throws(() => parseDotEnv('BAD-KEY=x'), /invalid env key "BAD-KEY"/);
  });
});

describe('formatDotEnv', () => {
  it('formats sorted KEY=value lines with a trailing newline', () => {
    assert.equal(formatDotEnv({ B: '2', A: '1' }), 'A=1\nB=2\n');
  });

  it('leaves safe values unquoted', () => {
    assert.equal(formatDotEnv({ URL: 'http://localhost:3000/a_b.c-d@e' }), 'URL=http://localhost:3000/a_b.c-d@e\n');
  });

  it('JSON-quotes values with special characters', () => {
    assert.equal(formatDotEnv({ FOO: 'a b' }), 'FOO="a b"\n');
    assert.equal(formatDotEnv({ FOO: 'line1\nline2' }), 'FOO="line1\\nline2"\n');
  });

  it('round-trips through parseDotEnv', () => {
    const env = { PLAIN: 'value', SPACED: 'a b c', QUOTED: 'he said "hi"', EMPTY: '' };
    assert.deepEqual(parseDotEnv(formatDotEnv(env)), env);
  });
});
