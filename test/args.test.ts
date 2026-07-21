import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';

describe('parseArgs', () => {
  it('parses the common flags', () => {
    const args = parseArgs(['-d', '--force', 'api'], 'up');
    assert.equal(args.detach, true);
    assert.equal(args.force, true);
    assert.deepEqual(args.positionals, ['api']);
  });

  it('parses --file in both forms', () => {
    assert.equal(parseArgs(['--file', 'other.yml'], 'up').file, 'other.yml');
    assert.equal(parseArgs(['--file=other.yml'], 'up').file, 'other.yml');
    assert.equal(parseArgs(['-f', 'other.yml'], 'up').file, 'other.yml');
  });

  it('parses --volumes for down', () => {
    assert.equal(parseArgs(['k8s'], 'down').volumes, false);
    assert.equal(parseArgs(['k8s', '--volumes'], 'down').volumes, true);
  });

  it('treats "logs -f" as --follow, not --file', () => {
    // The ambiguity: every other tool's `logs -f` means follow. Portler used to
    // read it as `--file`, so `portler logs -f api` silently parsed "api" as a
    // config path and then reported no logs for the (now empty) service list.
    const args = parseArgs(['-f', 'api'], 'logs');

    assert.equal(args.follow, true);
    assert.equal(args.file, undefined);
    assert.deepEqual(args.positionals, ['api']);
  });

  it('keeps "-f <path>" as --file for every other command', () => {
    const args = parseArgs(['-f', 'other.yml', 'api'], 'up');

    assert.equal(args.file, 'other.yml');
    assert.equal(args.follow, false);
    assert.deepEqual(args.positionals, ['api']);
  });

  it('still accepts the unambiguous long forms everywhere', () => {
    assert.equal(parseArgs(['--follow'], 'logs').follow, true);
    assert.equal(parseArgs(['--file', 'x.yml'], 'logs').file, 'x.yml');
  });

  it('rejects an unknown flag instead of passing it through as a service name', () => {
    // Previously "--detatch" landed in positionals and surfaced as the baffling
    // `unknown service "--detatch"`, and a misspelled flag with no service
    // context was ignored outright.
    assert.throws(() => parseArgs(['--detatch'], 'up'), /unknown flag "--detatch"/);
    assert.throws(() => parseArgs(['--detatch'], 'up'), /did you mean "--detach"\?/);
    assert.throws(() => parseArgs(['-x'], 'up'), /unknown flag "-x"/);
    assert.throws(() => parseArgs(['--nope=1'], 'up'), /unknown flag "--nope"/);
  });

  it('passes flag-looking values through after --', () => {
    const args = parseArgs(['--', '--not-a-flag'], 'up');
    assert.deepEqual(args.positionals, ['--not-a-flag']);
  });

  it('requires a value for flags that take one', () => {
    assert.throws(() => parseArgs(['--file'], 'up'), /--file requires a path/);
    assert.throws(() => parseArgs(['--file='], 'up'), /--file requires a path/);
    assert.throws(() => parseArgs(['--volume-set'], 'up'), /--volume-set requires a name/);
    assert.throws(() => parseArgs(['--volume-set='], 'up'), /--volume-set requires a name/);
  });
});
