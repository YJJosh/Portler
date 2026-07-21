import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDotEnv } from '../src/parse/dotenv.ts';
import { parseYaml } from '../src/parse/yaml.ts';
import { stripComment } from '../src/parse/scan.ts';

/**
 * A quote only opens a quoted span at the start of a value. Treating a mid-word
 * apostrophe as an opening quote made the scanner believe the rest of the line
 * was quoted, which silently swallowed trailing `# comments` (and, for a value
 * with two apostrophes, re-opened a span that ate the following text).
 */
describe('stripComment with mid-word quotes', () => {
  it('strips a comment after a value containing an apostrophe', () => {
    assert.equal(stripComment("it's fine # trailing comment"), "it's fine");
    assert.equal(stripComment("don't # nope"), "don't");
  });

  it('still honours genuinely quoted spans', () => {
    assert.equal(stripComment("'a # b' # comment"), "'a # b'");
    assert.equal(stripComment('"a # b" # comment'), '"a # b"');
  });

  it('leaves a # with no preceding whitespace alone', () => {
    assert.equal(stripComment('value#anchor'), 'value#anchor');
  });

  it('handles an apostrophe inside a double-quoted value', () => {
    assert.equal(stripComment(`"it's quoted" # comment`), `"it's quoted"`);
  });
});

describe('dotenv with apostrophes', () => {
  it('keeps a mid-word apostrophe and still strips the comment', () => {
    const env = parseDotEnv("MSG=it's fine # a comment\nNEXT=2\n");

    assert.equal(env.MSG, "it's fine");
    assert.equal(env.NEXT, '2');
  });

  it('does not let an apostrophe swallow the following lines', () => {
    const env = parseDotEnv("A=don't\nB=second\nC=third\n");

    assert.equal(env.A, "don't");
    assert.equal(env.B, 'second');
    assert.equal(env.C, 'third');
  });

  it('still unquotes properly quoted values', () => {
    const env = parseDotEnv(`A='single quoted'\nB="double quoted"\n`);

    assert.equal(env.A, 'single quoted');
    assert.equal(env.B, 'double quoted');
  });

  it('keeps a # inside a quoted value', () => {
    assert.equal(parseDotEnv('A="has # hash"').A, 'has # hash');
  });
});

describe('yaml with apostrophes', () => {
  it('keeps a mid-word apostrophe in a bare scalar and strips the comment', () => {
    const parsed = parseYaml("message: it's fine # a comment\nother: 2\n");

    assert.equal(parsed.message, "it's fine");
    assert.equal(parsed.other, 2);
  });

  it('handles a possessive apostrophe in a command', () => {
    const parsed = parseYaml("command: echo it's alive\n");
    assert.equal(parsed.command, "echo it's alive");
  });

  it('still parses genuinely single-quoted scalars', () => {
    const parsed = parseYaml("a: 'quoted # not a comment'\n");
    assert.equal(parsed.a, 'quoted # not a comment');
  });
});
