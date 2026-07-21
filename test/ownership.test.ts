import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dockerLabelArgs,
  inspectArgs,
  ownershipVerdict,
  parseInspection,
  parseInspectLabels,
  PROJECT_LABEL,
  removeOwnedContainer,
  removeOwnedNetwork,
  SERVICE_LABEL,
} from '../src/process/ownership.ts';
import type { CommandResult, CommandRunner } from '../src/util/exec.ts';

const PROJECT = '/home/dev/myapp';

/**
 * A fake docker: records every argv it is asked to run and answers from a
 * scripted list of outcomes. Nothing here talks to a daemon, so the tests
 * exercise the control flow — which command runs, with which arguments, after
 * which answer — rather than Docker itself.
 */
function fakeDocker(outcomes: CommandResult[]): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;

  const run: CommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const outcome = outcomes[index];
    index += 1;
    return outcome ?? { code: 0, stdout: '', stderr: '' };
  };

  return { run, calls };
}

function inspected(id: string, labels: Record<string, string> | null): CommandResult {
  return { code: 0, stdout: `${JSON.stringify({ id, labels })}\n`, stderr: '' };
}

const NOT_FOUND: CommandResult = { code: 1, stdout: '', stderr: 'Error: No such container: portler-api' };
const DAEMON_DOWN: CommandResult = {
  code: 1,
  stdout: '',
  stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
};

describe('ownershipVerdict', () => {
  it('claims a resource labelled with this project', () => {
    assert.equal(ownershipVerdict({ [PROJECT_LABEL]: PROJECT }, PROJECT), 'owned');
  });

  it('disowns a resource belonging to a different project', () => {
    assert.equal(ownershipVerdict({ [PROJECT_LABEL]: '/home/dev/other' }, PROJECT), 'foreign');
  });

  it('treats an unlabelled resource as foreign, never as ours', () => {
    // This is the whole point: a container that merely happens to hold the name
    // Portler derived must never be force-removed. We cannot prove we made it.
    assert.equal(ownershipVerdict({}, PROJECT), 'foreign');
    assert.equal(ownershipVerdict({ 'com.example.app': 'other' }, PROJECT), 'foreign');
  });

  it('reports a missing resource as absent', () => {
    assert.equal(ownershipVerdict(null, PROJECT), 'absent');
  });
});

describe('dockerLabelArgs', () => {
  it('labels a container with its project and service', () => {
    assert.deepEqual(dockerLabelArgs(PROJECT, 'api'), [
      '--label',
      `${PROJECT_LABEL}=${PROJECT}`,
      '--label',
      `${SERVICE_LABEL}=api`,
    ]);
  });

  it('labels a network with just the project', () => {
    assert.deepEqual(dockerLabelArgs(PROJECT), ['--label', `${PROJECT_LABEL}=${PROJECT}`]);
  });

  it('round-trips through ownershipVerdict', () => {
    const args = dockerLabelArgs(PROJECT, 'api');
    const labels = Object.fromEntries(
      args.filter((arg) => arg !== '--label').map((pair) => {
        const equals = pair.indexOf('=');
        return [pair.slice(0, equals), pair.slice(equals + 1)];
      }),
    );

    assert.equal(ownershipVerdict(labels, PROJECT), 'owned');
    assert.equal(ownershipVerdict(labels, '/somewhere/else'), 'foreign');
  });
});

describe('inspectArgs', () => {
  it('asks for the id and the labels in ONE inspect', () => {
    // Two separate calls could disagree: a container can be replaced under the
    // same name between them, and we would then remove an id we never checked.
    const args = inspectArgs('container', 'portler-api');
    assert.deepEqual(args.slice(0, 4), ['inspect', '--type', 'container', '--format']);
    assert.match(args[4]!, /\{\{json \.Id\}\}/);
    assert.match(args[4]!, /\{\{json \.Config\.Labels\}\}/);
    assert.equal(args[5], 'portler-api');
  });

  it('reads network labels from the top level, not from .Config', () => {
    const args = inspectArgs('network', 'portler-net');
    assert.deepEqual(args.slice(0, 3), ['network', 'inspect', '--format']);
    assert.match(args[3]!, /\{\{json \.Labels\}\}/);
    assert.equal(args[4], 'portler-net');
  });
});

describe('parseInspection', () => {
  it('reads the id and labels of an existing resource', () => {
    const result = parseInspection(0, '{"id":"abc123","labels":{"portler.project":"/p"}}', '');
    assert.deepEqual(result, { status: 'found', id: 'abc123', labels: { 'portler.project': '/p' } });
  });

  it('treats an unlabelled resource as found with no labels (hence foreign)', () => {
    const result = parseInspection(0, '{"id":"abc123","labels":null}', '');
    assert.deepEqual(result, { status: 'found', id: 'abc123', labels: {} });
  });

  it('distinguishes "no such container" from a broken daemon', () => {
    assert.deepEqual(parseInspection(1, '', 'Error: No such container: x'), { status: 'absent' });

    const error = parseInspection(1, '', DAEMON_DOWN.stderr);
    assert.equal(error.status, 'error', 'an unreachable daemon must NOT look like an absent resource');
  });

  it('reports unparseable output as an error rather than as absent', () => {
    assert.equal(parseInspection(0, 'not json', '').status, 'error');
    assert.equal(parseInspection(0, '', '').status, 'error');
    assert.equal(parseInspection(0, '{"labels":{}}', '').status, 'error', 'no id means nothing safe to remove');
  });
});

describe('removeOwnedContainer', () => {
  it('removes by IMMUTABLE ID, never by the (mutable) name', () => {
    // The name can be re-pointed at a different container between the inspect
    // and the rm — `docker rm -f <name>` would then destroy that new one, even
    // though the label we checked belonged to the old one.
    const docker = fakeDocker([inspected('sha256:deadbeef', { [PROJECT_LABEL]: PROJECT }), { code: 0, stdout: '', stderr: '' }]);

    return removeOwnedContainer('portler-api', PROJECT, docker.run).then((outcome) => {
      assert.deepEqual(outcome, { status: 'removed', id: 'sha256:deadbeef' });
      assert.deepEqual(docker.calls[1], ['docker', 'rm', '-f', 'sha256:deadbeef']);
      assert.ok(!docker.calls[1]!.includes('portler-api'), 'the rm must not reference the name at all');
    });
  });

  it('refuses a foreign container and never runs rm', async () => {
    const docker = fakeDocker([inspected('sha256:other', { [PROJECT_LABEL]: '/someone/else' })]);

    const outcome = await removeOwnedContainer('portler-api', PROJECT, docker.run);

    assert.deepEqual(outcome, { status: 'foreign' });
    assert.equal(docker.calls.length, 1, 'only the inspect ran');
  });

  it('refuses an UNLABELLED container with a colliding name', async () => {
    const docker = fakeDocker([inspected('sha256:strangers', null)]);

    assert.deepEqual(await removeOwnedContainer('portler-api', PROJECT, docker.run), { status: 'foreign' });
    assert.equal(docker.calls.length, 1);
  });

  it('reports an absent container as absent', async () => {
    const docker = fakeDocker([NOT_FOUND]);
    assert.deepEqual(await removeOwnedContainer('portler-api', PROJECT, docker.run), { status: 'absent' });
  });

  it('reports a dead daemon as an error, NOT as a successful cleanup', async () => {
    // The bug this guards: `if (inspect failed) return 'absent'` told `down`
    // there was nothing to remove, so it wiped the PID entries naming the
    // container and left it running forever.
    const docker = fakeDocker([DAEMON_DOWN]);

    const outcome = await removeOwnedContainer('portler-api', PROJECT, docker.run);

    assert.equal(outcome.status, 'error');
    assert.match(outcome.status === 'error' ? outcome.message : '', /docker daemon/i);
    assert.equal(docker.calls.length, 1, 'no rm is attempted when ownership is unknown');
  });

  it('surfaces a failing rm as failed (ours, but not removed)', async () => {
    const docker = fakeDocker([
      inspected('sha256:deadbeef', { [PROJECT_LABEL]: PROJECT }),
      { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' },
    ]);

    const outcome = await removeOwnedContainer('portler-api', PROJECT, docker.run);

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.status === 'failed' ? outcome.message : '', /permission denied/);
  });

  it('treats an rm that lost a race (already gone) as done', async () => {
    const docker = fakeDocker([
      inspected('sha256:deadbeef', { [PROJECT_LABEL]: PROJECT }),
      { code: 1, stdout: '', stderr: 'Error response from daemon: No such container: sha256:deadbeef' },
    ]);

    assert.deepEqual(await removeOwnedContainer('portler-api', PROJECT, docker.run), { status: 'absent' });
  });
});

describe('removeOwnedNetwork', () => {
  it('removes an owned network by id', async () => {
    const docker = fakeDocker([inspected('net123', { [PROJECT_LABEL]: PROJECT }), { code: 0, stdout: '', stderr: '' }]);

    assert.deepEqual(await removeOwnedNetwork('portler-net', PROJECT, docker.run), { status: 'removed', id: 'net123' });
    assert.deepEqual(docker.calls[1], ['docker', 'network', 'rm', 'net123']);
  });

  it('leaves a foreign network alone', async () => {
    const docker = fakeDocker([inspected('net123', { [PROJECT_LABEL]: '/other' })]);

    assert.deepEqual(await removeOwnedNetwork('portler-net', PROJECT, docker.run), { status: 'foreign' });
    assert.equal(docker.calls.length, 1);
  });
});

describe('parseInspectLabels', () => {
  it('parses a docker inspect label map', () => {
    assert.deepEqual(parseInspectLabels('{"portler.project":"/p","a":"b"}\n'), { 'portler.project': '/p', a: 'b' });
  });

  it('treats docker\'s "null" (no labels) as an empty map, which is foreign', () => {
    assert.deepEqual(parseInspectLabels('null'), {});
    assert.equal(ownershipVerdict(parseInspectLabels('null'), PROJECT), 'foreign');
  });

  it('does not crash on empty or malformed output', () => {
    assert.deepEqual(parseInspectLabels(''), {});
    assert.deepEqual(parseInspectLabels('not json'), {});
    assert.deepEqual(parseInspectLabels('[1,2]'), {});
  });
});

describe('volume removal ownership (portler volumes remove)', () => {
  // removeVolume() shells out to docker, so the ownership DECISION is what we
  // test here — deleting a volume is the one irreversible data-loss operation
  // in Portler, and it must never fire on a volume it cannot prove it created.
  const volumeRoot = '/home/dev/myapp';

  it('claims a volume labelled by this project', () => {
    assert.equal(ownershipVerdict({ [PROJECT_LABEL]: volumeRoot }, volumeRoot), 'owned');
  });

  it('refuses an unlabelled volume, even under a matching name', () => {
    assert.equal(ownershipVerdict({}, volumeRoot), 'foreign');
  });

  it('refuses a volume labelled for a different project root', () => {
    assert.equal(ownershipVerdict({ [PROJECT_LABEL]: '/home/dev/other' }, volumeRoot), 'foreign');
  });
});
