import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dockerLabelArgs,
  inspectArgs,
  mountedVolumeSet,
  ownedContainerLiveness,
  ownershipVerdict,
  parseInspection,
  parseInspectLabels,
  PROJECT_LABEL,
  removeOwnedContainer,
  removeOwnedNetwork,
  SERVICE_LABEL,
} from '../src/process/ownership.ts';
import { managedVolumeMount } from '../src/config/volumes.ts';
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

describe('ownedContainerLiveness', () => {
  function inspectedState(id: string, labels: Record<string, string> | null, running: boolean): CommandResult {
    return { code: 0, stdout: `${JSON.stringify({ id, labels, running })}\n`, stderr: '' };
  }

  it('reads the running state from the same inspect as the id and labels', () => {
    // One call: a container replaced under the name between two inspects could
    // be running while the one whose label we checked is gone.
    assert.match(inspectArgs('container', 'portler-api')[4]!, /\{\{json \.State\.Running\}\}/);
    assert.deepEqual(parseInspection(0, '{"id":"abc123","labels":{"portler.project":"/p"},"running":true}', ''), {
      status: 'found',
      id: 'abc123',
      labels: { 'portler.project': '/p' },
      running: true,
    });
  });

  it("reports this project's running container as running", async () => {
    const docker = fakeDocker([inspectedState('sha256:deadbeef', { [PROJECT_LABEL]: PROJECT }, true)]);
    assert.deepEqual(await ownedContainerLiveness('portler-api', PROJECT, docker.run), { status: 'running', id: 'sha256:deadbeef' });
    assert.equal(docker.calls.length, 1, 'one inspect, nothing removed');
  });

  it("reports an exited container, a missing one, and a stranger's as gone", async () => {
    for (const outcome of [
      inspectedState('sha256:deadbeef', { [PROJECT_LABEL]: PROJECT }, false),
      NOT_FOUND,
      inspectedState('sha256:strangers', null, true),
      inspectedState('sha256:other', { [PROJECT_LABEL]: '/someone/else' }, true),
    ]) {
      assert.deepEqual(await ownedContainerLiveness('portler-api', PROJECT, fakeDocker([outcome]).run), { status: 'gone' });
    }
  });

  it('does not guess when the daemon cannot be asked', async () => {
    const result = await ownedContainerLiveness('portler-api', PROJECT, fakeDocker([DAEMON_DOWN]).run);
    assert.equal(result.status, 'error');
  });
});

describe('mountedVolumeSet', () => {
  type Mount = { Type: string; Name?: string; Destination?: string };
  function container(labels: Record<string, string> | null, mounts: Mount[]): CommandResult {
    return { code: 0, stdout: `${JSON.stringify({ labels, mounts })}\n`, stderr: '' };
  }
  function volumes(...labels: Array<Record<string, string> | null>): CommandResult {
    return { code: 0, stdout: labels.map((entry) => JSON.stringify(entry)).join('\n') + '\n', stderr: '' };
  }
  const OURS = { [PROJECT_LABEL]: PROJECT };
  const DATA = { [PROJECT_LABEL]: PROJECT, 'portler.volume': 'data' };
  const LOGS = { [PROJECT_LABEL]: PROJECT, 'portler.volume': 'logs' };
  const EXPECTED = [{ name: 'data', destination: '/data' }];

  it("reads the set from the labels of the service's @ volumes, by the paths they are mounted at", async () => {
    const docker = fakeDocker([
      container(OURS, [
        { Type: 'volume', Name: 'portler-myapp-x-data--branch', Destination: '/data' },
        { Type: 'bind', Destination: '/src' },
        { Type: 'volume', Name: 'scratch', Destination: '/scratch' },
      ]),
      volumes({ ...DATA, 'portler.volume-set': 'branch' }),
    ]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], docker.run), { status: 'set', set: 'branch' });
    // Only the volume at the @ path is inspected.
    assert.deepEqual(docker.calls[1], ['docker', 'volume', 'inspect', '--format', '{{json .Labels}}', 'portler-myapp-x-data--branch']);
  });

  it('matches an @ entry by the name Portler created its volume and label under', async () => {
    // `@Data Store` is created as `data-store`; the raw name would match nothing and abstain.
    const expected = [managedVolumeMount('@Data Store:/data/')!];
    assert.deepEqual(expected, [{ name: 'data-store', destination: '/data' }]);
    const docker = fakeDocker([
      container(OURS, [{ Type: 'volume', Name: 'portler-myapp-x-data-store--branch', Destination: '/data' }]),
      volumes({ [PROJECT_LABEL]: PROJECT, 'portler.volume': 'data-store', 'portler.volume-set': 'branch' }),
    ]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, expected, [PROJECT], docker.run), { status: 'set', set: 'branch' });
  });

  it("lets only this project's volumes vote", async () => {
    const at: Mount = { Type: 'volume', Name: 'portler-other-data--branch', Destination: '/data' };
    // Another project's volume with the same short name, at the @ path: no vote.
    const foreign = fakeDocker([container(OURS, [at]), volumes({ [PROJECT_LABEL]: '/elsewhere', 'portler.volume': 'data', 'portler.volume-set': 'branch' })]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], foreign.run), { status: 'none' });
    const unowned = fakeDocker([container(OURS, [at]), volumes({ 'portler.volume': 'data', 'portler.volume-set': 'branch' })]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], unowned.run), { status: 'none' });
    // A named production stack labels its volumes with the name, which the caller passes.
    const named = fakeDocker([container(OURS, [at]), volumes({ [PROJECT_LABEL]: 'shop', 'portler.volume': 'data', 'portler.volume-set': 'branch' })]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT, 'shop'], named.run), { status: 'set', set: 'branch' });
  });

  it('ignores an explicitly named Portler volume next to the @ volume', async () => {
    // `@data` on branch, plus the base `data` volume mounted by its full name elsewhere.
    const docker = fakeDocker([
      container(OURS, [
        { Type: 'volume', Name: 'portler-myapp-x-data--branch', Destination: '/data' },
        { Type: 'volume', Name: 'portler-myapp-x-data', Destination: '/seed' },
      ]),
      volumes({ ...DATA, 'portler.volume-set': 'branch' }),
    ]);
    assert.deepEqual(await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], docker.run), { status: 'set', set: 'branch' });
  });

  it("reports the base volumes as '' and abstains when nothing at an @ path is that @ volume", async () => {
    const at = (name: string): Mount => ({ Type: 'volume', Name: name, Destination: '/data' });
    assert.deepEqual(
      await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], fakeDocker([container(OURS, [at('base')]), volumes(DATA)]).run),
      { status: 'set', set: '' },
    );
    assert.deepEqual(
      await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], fakeDocker([container(OURS, [{ Type: 'bind', Destination: '/data' }])]).run),
      { status: 'none' },
    );
    // A managed volume elsewhere, or a different volume at the @ path (a config change, a
    // hand-made volume), does not vote.
    assert.deepEqual(
      await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], fakeDocker([container(OURS, [{ Type: 'volume', Name: 'v', Destination: '/other' }])]).run),
      { status: 'none' },
    );
    assert.deepEqual(
      await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], fakeDocker([container(OURS, [at('v')]), volumes({ ...LOGS, 'portler.volume-set': 'x' })]).run),
      { status: 'none' },
    );
    assert.deepEqual(
      await mountedVolumeSet('portler-db', PROJECT, EXPECTED, [PROJECT], fakeDocker([container(OURS, [at('scratch')]), volumes({ other: 'x' })]).run),
      { status: 'none' },
    );
  });

  it('does not guess when the container is gone, a stranger, unreadable, or its @ volumes are on two sets', async () => {
    const two = [{ name: 'data', destination: '/data' }, { name: 'logs', destination: '/logs' }];
    const both: Mount[] = [
      { Type: 'volume', Name: 'a', Destination: '/data' },
      { Type: 'volume', Name: 'b', Destination: '/logs' },
    ];
    const cases: Array<[CommandResult[], ReadonlyArray<{ name: string; destination: string }>]> = [
      [[NOT_FOUND], EXPECTED],
      [[DAEMON_DOWN], EXPECTED],
      [[container({ [PROJECT_LABEL]: '/someone/else' }, [{ Type: 'volume', Name: 'v', Destination: '/data' }])], EXPECTED],
      [[container(OURS, [{ Type: 'volume', Name: 'a', Destination: '/data' }]), DAEMON_DOWN], EXPECTED],
      [[container(OURS, both), volumes(DATA, { ...LOGS, 'portler.volume-set': 'branch' })], two],
      [[container(OURS, both), volumes(DATA)], two],
    ];
    for (const [outcomes, expected] of cases) {
      const result = await mountedVolumeSet('portler-db', PROJECT, expected, [PROJECT], fakeDocker(outcomes).run);
      assert.equal(result.status, 'unknown', JSON.stringify(outcomes));
    }
  });
});
