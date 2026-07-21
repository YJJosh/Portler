import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { darwinPsArgs, identityVerdict, maySignal, parseDarwinStartToken, readProcessStartToken } from '../src/process/identity.ts';

describe('identityVerdict', () => {
  it('permits signalling a pid whose start token still matches', () => {
    assert.equal(identityVerdict('12345', '12345', true), 'match');
    assert.equal(maySignal('match'), true);
  });

  it('refuses a pid that the OS recycled onto another process', () => {
    // Same pid number, different process: the recorded token cannot match the
    // start time of whatever holds the pid now.
    assert.equal(identityVerdict('12345', '99999', true), 'reused');
    assert.equal(maySignal('reused'), false);
  });

  it('reports a vanished process as gone', () => {
    assert.equal(identityVerdict('12345', null, false), 'gone');
    assert.equal(maySignal('gone'), false);
  });

  it('FAILS CLOSED on a legacy entry with no recorded token', () => {
    // The regression this whole module exists for: a pids.json entry written by
    // an older Portler records a pid and nothing else. Years (or a pid wrap)
    // later that number belongs to something else entirely. "We cannot tell" is
    // not permission to kill a process group.
    assert.equal(identityVerdict(undefined, '12345', true), 'unverifiable');
    assert.equal(maySignal('unverifiable'), false);
  });

  it('FAILS CLOSED when the token could not be captured at spawn', () => {
    // Same shape as a legacy entry: pidInfoFor could not read the token, so the
    // entry has none. It is never signalled by an ordinary down.
    assert.equal(identityVerdict(undefined, 'anything', true), 'unverifiable');
  });

  it('FAILS CLOSED when the current token cannot be read for a live pid', () => {
    // The pid exists but the platform will not say who it is (another user's
    // process, an unsupported OS). Refuse rather than guess.
    assert.equal(identityVerdict('12345', null, true), 'unverifiable');
    assert.equal(maySignal('unverifiable'), false);
  });

  it('treats a dead pid as gone even when no token was ever recorded', () => {
    assert.equal(identityVerdict(undefined, null, false), 'gone');
  });
});

describe('readProcessStartToken', () => {
  it('returns a stable token for a live process', async () => {
    const first = await readProcessStartToken(process.pid);
    const second = await readProcessStartToken(process.pid);

    assert.ok(first, 'expected a start token for our own pid');
    assert.equal(first, second, 'the token must not change between reads');
  });

  it('returns null for a pid that does not exist', async () => {
    assert.equal(await readProcessStartToken(0), null);
    assert.equal(await readProcessStartToken(-1), null);
  });

  it('gives different processes different tokens', async () => {
    // Production services are detached process-group leaders. On macOS the
    // token is lstart (one-second resolution) + pgid, so a non-detached test
    // child spawned in the same second can legitimately share its parent's token.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore', detached: true });
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      const childToken = await readProcessStartToken(child.pid!);
      const ownToken = await readProcessStartToken(process.pid);

      assert.ok(childToken);
      assert.notEqual(childToken, ownToken);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reports the process as gone once it exits', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = await new Promise<number>((resolve) => child.once('spawn', () => resolve(child.pid!)));
    await new Promise((resolve) => child.once('exit', resolve));
    // The pid is reaped by the time 'exit' fires, so no token remains.
    assert.equal(await readProcessStartToken(pid), null);
  });

});

describe('macOS start token (parsed off-Mac, so the policy is covered everywhere)', () => {
  it('asks ps for the start time AND the process-group id', () => {
    // lstart alone has one-second resolution. The pgid narrows it further: a
    // Portler-spawned service is detached, so it leads its own process group,
    // and a process that later inherits the pid has pgid <pid> only if it too
    // is a process-group leader.
    assert.deepEqual(darwinPsArgs(4321), ['-o', 'lstart=,pgid=', '-p', '4321']);
  });

  it('normalizes ps column padding so the token is stable', () => {
    assert.equal(parseDarwinStartToken(0, 'Mon Jul  7 09:15:01 2025   1234\n'), 'Mon Jul 7 09:15:01 2025 1234');
  });

  it('returns null for a dead pid (ps exits non-zero with no rows)', () => {
    assert.equal(parseDarwinStartToken(1, ''), null);
  });

  it('refuses ambiguous output rather than guessing', () => {
    // Two rows means we did not identify a single process. Under the fail-closed
    // policy a null token makes a live pid 'unverifiable', so it is not signalled.
    assert.equal(parseDarwinStartToken(0, 'Mon Jul 7 09:15:01 2025 1\nTue Jul 8 10:00:00 2025 2\n'), null);
    assert.equal(parseDarwinStartToken(0, '   \n'), null);
    assert.equal(identityVerdict('token', parseDarwinStartToken(0, ''), true), 'unverifiable');
  });
});
