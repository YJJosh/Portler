import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkEndpointLocality,
  classifyApiEndpoint,
  classifyContext,
  CONTEXT_OVERRIDE_ENV,
  type ClusterInfo,
  ENDPOINT_OVERRIDE_ENV,
  resolveCluster,
} from '../src/k8s/cluster.ts';
import { isForwardSpec, portForwardArgs } from '../src/k8s/forward-supervisor.ts';
import {
  deleteK8sResources,
  deleteResourceKinds,
  deleteSelector,
  ensureNamespace,
  ensureNamespaceClaimable,
  getNamespacePhase,
  isNamespaceNotFound,
  namespaceOwnership,
  parseNamespaceRead,
  readNamespace,
} from '../src/k8s/kubectl.ts';
import { containerEnvEntries, k8sServiceNames, MANAGED_BY_LABEL, PROJECT_LABEL, projectLabels } from '../src/k8s/manifests.ts';
import { validateK8sMode } from '../src/cli/commands/up-k8s.ts';
import type { CommandResult, CommandRunner } from '../src/util/exec.ts';
import type { PortlerConfig, ServiceConfig } from '../src/types/index.ts';

const PROJECT_DIR = '/home/dev/myapp';
const CLUSTER: ClusterInfo = { type: 'kind', context: 'kind-dev', name: 'dev' };

/** Scripted kubectl: records argv, answers from a queue of command outcomes. */
function fakeKubectl(outcomes: CommandResult[]): { run: CommandRunner; calls: string[][]; stdin: (string | undefined)[] } {
  const calls: string[][] = [];
  const stdin: (string | undefined)[] = [];
  let index = 0;

  const run: CommandRunner = async (command, args, input) => {
    calls.push([command, ...args]);
    stdin.push(input);
    const outcome = outcomes[index];
    index += 1;
    return outcome ?? { code: 0, stdout: '', stderr: '' };
  };

  return { run, calls, stdin };
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };
const NS_NOT_FOUND: CommandResult = {
  code: 1,
  stdout: '',
  stderr: 'Error from server (NotFound): namespaces "portler-myapp-abc" not found',
};
const API_DOWN: CommandResult = {
  code: 1,
  stdout: '',
  stderr: 'The connection to the server 127.0.0.1:6443 was refused - did you specify the right host or port?',
};
const FORBIDDEN: CommandResult = {
  code: 1,
  stdout: '',
  stderr: 'Error from server (Forbidden): namespaces "portler-myapp-abc" is forbidden: User cannot get resource',
};

function namespaceJson(labels: Record<string, string>): CommandResult {
  return {
    code: 0,
    stdout: JSON.stringify({ kind: 'Namespace', metadata: { name: 'portler-myapp-abc', labels } }),
    stderr: '',
  };
}

function makeConfig(services: Record<string, ServiceConfig> = {}): PortlerConfig {
  return {
    filePath: `${PROJECT_DIR}/portler.yml`,
    projectDir: PROJECT_DIR,
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 51000, end: 59999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: PROJECT_DIR,
    volumes: [],
    k8sNamespace: 'portler-myapp-abc',
    services,
  };
}

describe('containerEnvEntries', () => {
  it('keeps composed PORTLER values but excludes inherited host controls, secrets, and internal defaults', () => {
    const env = {
      APP_KEY: 'project-value',
      PORTLER_API_URL: 'http://localhost:52001',
      PORTLER_DECLARED_FLAG: 'kept',
      PORTLER_SERVICE_NAME: 'api',
      PORTLER_GLOBAL_DIR: '/host/private/.portler',
      PORTLER_HOME: '/host/private/portler-home',
      PORTLER_ALLOW_K8S_CONTEXT: 'private-context',
      PORTLER_ALLOW_K8S_ENDPOINT: 'https://cluster.example:6443',
      PORTLER_INHERITED_SECRET: 'must-not-leak',
      PATH: '/usr/bin',
      pnpm_config_verify_deps_before_run: 'false',
    };
    const explicitKeys = new Set([
      'APP_KEY',
      'PORTLER_API_URL',
      'PORTLER_DECLARED_FLAG',
      'PORTLER_SERVICE_NAME',
      // Internal host defaults stay excluded even when buildServiceEnv records
      // that it injected them into the composed environment.
      'pnpm_config_verify_deps_before_run',
    ]);

    assert.deepEqual(containerEnvEntries(env, explicitKeys), [
      { name: 'APP_KEY', value: 'project-value' },
      { name: 'PORTLER_API_URL', value: 'http://localhost:52001' },
      { name: 'PORTLER_DECLARED_FLAG', value: 'kept' },
      { name: 'PORTLER_SERVICE_NAME', value: 'api' },
    ]);
  });
});

describe('classifyContext', () => {
  it('recognizes the local cluster flavors', () => {
    assert.deepEqual(classifyContext('kind-dev'), { type: 'kind', context: 'kind-dev', name: 'dev' });
    assert.deepEqual(classifyContext('k3d-dev'), { type: 'k3d', context: 'k3d-dev', name: 'dev' });
    assert.deepEqual(classifyContext('minikube'), { type: 'minikube', context: 'minikube', name: 'minikube' });
    assert.equal(classifyContext('docker-desktop')?.type, 'docker-desktop');
    assert.equal(classifyContext('rancher-desktop')?.type, 'rancher-desktop');
    assert.equal(classifyContext('orbstack')?.type, 'orbstack');
    assert.equal(classifyContext('colima')?.type, 'colima');
  });

  it('does not recognize remote-looking contexts', () => {
    assert.equal(classifyContext('prod-eks'), null);
    assert.equal(classifyContext('arn:aws:eks:us-east-1:1234:cluster/prod'), null);
    assert.equal(classifyContext('gke_acme-prod_us-central1_main'), null);
    // Substring lookalikes must not slip through.
    assert.equal(classifyContext('not-kind-really'), null);
    assert.equal(classifyContext('minikube-prod'), null);
  });
});

describe('resolveCluster', () => {
  it('accepts a local context', () => {
    assert.equal(resolveCluster('kind-dev', undefined).type, 'kind');
  });

  it('REFUSES an unrecognized context rather than risk acting on production', () => {
    assert.throws(
      () => resolveCluster('prod-eks', undefined),
      /refusing to use kubectl context "prod-eks"/,
    );
  });

  it('allows an unrecognized context only when the override names it exactly', () => {
    const cluster = resolveCluster('my-lab-cluster', 'my-lab-cluster');
    assert.equal(cluster.type, 'allowed');
    assert.equal(cluster.context, 'my-lab-cluster');
  });

  it('does not let an override for one context unlock a different one', () => {
    // The override is a specific name, not a blanket "yes" — so a stale export
    // cannot silently authorize whatever context happens to be active later.
    assert.throws(() => resolveCluster('prod-eks', 'my-lab-cluster'), /refusing to use kubectl context/);
    assert.throws(() => resolveCluster('prod-eks', 'true'), /refusing to use kubectl context/);
    assert.throws(() => resolveCluster('prod-eks', ''), /refusing to use kubectl context/);
  });

  it('names the override env var in the error so the escape hatch is discoverable', () => {
    assert.throws(() => resolveCluster('prod-eks', undefined), new RegExp(CONTEXT_OVERRIDE_ENV));
  });
});

describe('namespaceOwnership', () => {
  const config = makeConfig();

  it('claims a namespace Portler labelled', () => {
    assert.equal(namespaceOwnership(projectLabels(config), config), 'owned');
  });

  it('reports a missing namespace as absent', () => {
    assert.equal(namespaceOwnership(null, config), 'absent');
  });

  it('refuses to claim a pre-existing, unlabelled namespace', () => {
    // e.g. the user pointed k8s_namespace: at "default" or a shared team
    // namespace. Deleting it would take everyone else's workloads with it.
    assert.equal(namespaceOwnership({}, config), 'foreign');
  });

  it('refuses a namespace managed by another tool', () => {
    assert.equal(namespaceOwnership({ [MANAGED_BY_LABEL]: 'helm' }, config), 'foreign');
  });

  it('refuses a Portler namespace belonging to a DIFFERENT project', () => {
    const otherProject = { ...projectLabels(config), [PROJECT_LABEL]: 'someotherhash' };
    assert.equal(namespaceOwnership(otherProject, config), 'foreign');
  });
});

describe('reading a namespace (kubectl output, not a guess)', () => {
  const config = makeConfig();

  it('asks for -o json, because jsonpath does NOT print JSON', () => {
    // The bug: `-o jsonpath={.metadata.labels}` renders a Go map — `map[a:b]`,
    // or `map[]` when unlabelled. JSON.parse threw on that, the catch returned
    // {}, and every namespace looked unlabelled: an owned namespace read as
    // foreign, and (worse) the labels that prove ownership were never seen.
    const kubectl = fakeKubectl([namespaceJson(projectLabels(config))]);

    return readNamespace(CLUSTER, 'portler-myapp-abc', kubectl.run).then((read) => {
      assert.deepEqual(kubectl.calls[0], [
        'kubectl',
        '--context',
        'kind-dev',
        'get',
        'namespace',
        'portler-myapp-abc',
        '-o',
        'json',
      ]);
      assert.equal(read.status, 'found');
      assert.equal(namespaceOwnership(read.status === 'found' ? read.labels : null, config), 'owned');
    });
  });

  it('parses a Go map like the old jsonpath output as an ERROR, not as "no labels"', () => {
    assert.equal(parseNamespaceRead(0, 'map[portler.project:abc]', '').status, 'error');
  });

  it('reads an unlabelled namespace as found-with-no-labels (hence foreign)', () => {
    const read = parseNamespaceRead(0, JSON.stringify({ metadata: { name: 'shared' } }), '');
    assert.deepEqual(read, { status: 'found', labels: {} });
    assert.equal(namespaceOwnership(read.status === 'found' ? read.labels : null, config), 'foreign');
  });

  it('distinguishes NotFound from an unreachable API server', () => {
    assert.deepEqual(parseNamespaceRead(1, '', NS_NOT_FOUND.stderr), { status: 'absent' });
    assert.equal(parseNamespaceRead(1, '', API_DOWN.stderr).status, 'error');
    assert.equal(parseNamespaceRead(1, '', FORBIDDEN.stderr).status, 'error');
  });
});

describe('ensureNamespaceClaimable', () => {
  const config = makeConfig();

  it('accepts an absent namespace (Portler will create it)', async () => {
    const kubectl = fakeKubectl([NS_NOT_FOUND]);
    assert.equal(await ensureNamespaceClaimable(CLUSTER, config, kubectl.run), 'absent');
  });

  it('accepts a namespace already labelled as ours', async () => {
    const kubectl = fakeKubectl([namespaceJson(projectLabels(config))]);
    assert.equal(await ensureNamespaceClaimable(CLUSTER, config, kubectl.run), 'owned');
  });

  it('refuses a foreign namespace', async () => {
    const kubectl = fakeKubectl([namespaceJson({})]);
    await assert.rejects(ensureNamespaceClaimable(CLUSTER, config, kubectl.run), /not managed by this Portler project/);
  });

  it('FAILS when ownership cannot be read, instead of assuming absent', async () => {
    // An auth error or a dead API server must never be read as "the namespace
    // does not exist, go ahead and own it".
    const kubectl = fakeKubectl([FORBIDDEN]);
    await assert.rejects(ensureNamespaceClaimable(CLUSTER, config, kubectl.run), /could not determine whether namespace/);

    const down = fakeKubectl([API_DOWN]);
    await assert.rejects(ensureNamespaceClaimable(CLUSTER, config, down.run), /could not determine whether namespace/);
  });
});

describe('ensureNamespace (create, never apply)', () => {
  const config = makeConfig();

  it('creates an absent namespace with kubectl create -f - and the labelled manifest', async () => {
    const kubectl = fakeKubectl([NS_NOT_FOUND, OK]);

    await ensureNamespace(CLUSTER, config, kubectl.run);

    assert.deepEqual(kubectl.calls[1], ['kubectl', '--context', 'kind-dev', 'create', '-f', '-']);
    assert.ok(!kubectl.calls.some((call) => call.includes('apply')), 'apply would ADOPT a raced foreign namespace');

    const manifest = kubectl.stdin[1] ?? '';
    assert.match(manifest, /kind: Namespace/);
    assert.match(manifest, new RegExp(MANAGED_BY_LABEL.replace('.', '\\.')));
  });

  it('does nothing when the namespace is already ours', async () => {
    const kubectl = fakeKubectl([namespaceJson(projectLabels(config))]);

    await ensureNamespace(CLUSTER, config, kubectl.run);

    assert.equal(kubectl.calls.length, 1, 'no create for a namespace we already own');
  });

  it('re-reads after AlreadyExists and ACCEPTS a namespace that turns out to be ours', async () => {
    // Two `portler up k8s` runs racing in the same project: one create wins,
    // the other gets AlreadyExists and must simply carry on.
    const kubectl = fakeKubectl([
      NS_NOT_FOUND,
      { code: 1, stdout: '', stderr: 'Error from server (AlreadyExists): namespaces "portler-myapp-abc" already exists' },
      namespaceJson(projectLabels(config)),
    ]);

    await ensureNamespace(CLUSTER, config, kubectl.run);

    assert.equal(kubectl.calls.length, 3);
    assert.deepEqual(kubectl.calls[2]?.slice(3), ['get', 'namespace', 'portler-myapp-abc', '-o', 'json']);
  });

  it('re-reads after AlreadyExists and REFUSES a namespace raced in by someone else', async () => {
    // THE RACE: our check says absent, a foreign namespace appears, our create
    // loses. `apply` would have adopted it — labelling a stranger's namespace as
    // Portler's and authorizing a later `down --volumes` to delete it.
    const kubectl = fakeKubectl([
      NS_NOT_FOUND,
      { code: 1, stdout: '', stderr: 'Error from server (AlreadyExists): namespaces "portler-myapp-abc" already exists' },
      namespaceJson({ 'app.kubernetes.io/managed-by': 'helm' }),
    ]);

    await assert.rejects(ensureNamespace(CLUSTER, config, kubectl.run), /not managed by this Portler project/);
  });

  it('propagates a create failure that is not AlreadyExists', async () => {
    const kubectl = fakeKubectl([NS_NOT_FOUND, { code: 1, stdout: '', stderr: 'Error from server (Forbidden): cannot create' }]);

    await assert.rejects(ensureNamespace(CLUSTER, config, kubectl.run), /could not create namespace/);
  });
});

describe('deleteK8sResources', () => {
  const config = makeConfig();

  it('deletes only labelled resources in an owned namespace', async () => {
    const kubectl = fakeKubectl([namespaceJson(projectLabels(config)), OK]);

    await deleteK8sResources(CLUSTER, config, {}, kubectl.run);

    const deleteCall = kubectl.calls[1]!;
    assert.deepEqual(deleteCall.slice(0, 5), ['kubectl', '--context', 'kind-dev', 'delete', 'deployment,service']);
    assert.ok(deleteCall.includes('--selector'));
    assert.ok(deleteCall.some((arg) => arg.includes(`${MANAGED_BY_LABEL}=portler`)));
  });

  it('does nothing for an absent namespace', async () => {
    const kubectl = fakeKubectl([NS_NOT_FOUND]);

    await deleteK8sResources(CLUSTER, config, {}, kubectl.run);

    assert.equal(kubectl.calls.length, 1, 'no delete is issued');
  });

  it('refuses to delete inside a foreign namespace', async () => {
    const kubectl = fakeKubectl([namespaceJson({})]);

    await assert.rejects(deleteK8sResources(CLUSTER, config, {}, kubectl.run), /not managed by this Portler project/);
    assert.equal(kubectl.calls.length, 1);
  });

  it('THROWS when the namespace cannot be read, instead of reporting success', async () => {
    const kubectl = fakeKubectl([API_DOWN]);

    await assert.rejects(deleteK8sResources(CLUSTER, config, {}, kubectl.run), /could not determine whether namespace/);
  });

  it('THROWS when the delete itself fails, instead of warning and returning', async () => {
    // The old code printed a warning and returned normally: `down` exited 0 and
    // released the ports while the Deployments were still running.
    const kubectl = fakeKubectl([
      namespaceJson(projectLabels(config)),
      { code: 1, stdout: '', stderr: 'error: failed to delete: connection refused' },
    ]);

    await assert.rejects(deleteK8sResources(CLUSTER, config, {}, kubectl.run), /could not delete Kubernetes resources/);
  });

  it('THROWS when a namespace delete fails on the --volumes path', async () => {
    const kubectl = fakeKubectl([
      namespaceJson(projectLabels(config)),
      { code: 1, stdout: '', stderr: 'error: namespace delete forbidden' },
    ]);

    await assert.rejects(
      deleteK8sResources(CLUSTER, config, { deleteVolumes: true }, kubectl.run),
      /could not delete Kubernetes namespace/,
    );
  });
});

describe('classifyApiEndpoint', () => {
  it('accepts the endpoints the local cluster flavors actually publish', () => {
    assert.equal(classifyApiEndpoint('https://127.0.0.1:6443'), 'loopback'); // kind, k3d, colima, rancher
    assert.equal(classifyApiEndpoint('https://kubernetes.docker.internal:6443'), 'loopback'); // docker desktop
    assert.equal(classifyApiEndpoint('https://0.0.0.0:26443'), 'loopback'); // orbstack
    assert.equal(classifyApiEndpoint('https://[::1]:6443'), 'loopback');
    assert.equal(classifyApiEndpoint('https://192.168.49.2:8443'), 'private'); // minikube VM
    assert.equal(classifyApiEndpoint('https://10.0.2.15:6443'), 'private');
  });

  it('classifies a real cluster endpoint as remote', () => {
    // A context can be NAMED "minikube" and point at production. The endpoint is
    // the second, independent gate.
    assert.equal(classifyApiEndpoint('https://ABC123.gr7.us-east-1.eks.amazonaws.com'), 'remote');
    assert.equal(classifyApiEndpoint('https://k8s.internal.corp.example.com:6443'), 'remote');
    assert.equal(classifyApiEndpoint('https://34.120.0.1:443'), 'remote');
  });

  it('does not mistake a DNS name beginning with 127 for a loopback IP literal', () => {
    assert.equal(classifyApiEndpoint('https://127.production.example.com:6443'), 'remote');
    assert.equal(classifyApiEndpoint('https://127.0.0.1.attacker.example:6443'), 'remote');
  });

  it('reports an unusable endpoint as unknown', () => {
    assert.equal(classifyApiEndpoint(undefined), 'unknown');
    assert.equal(classifyApiEndpoint(''), 'unknown');
    assert.equal(classifyApiEndpoint('not a url'), 'unknown');
  });
});

describe('checkEndpointLocality', () => {
  it('accepts, without a prompt, only endpoints that are certainly on this machine', () => {
    // Loopback, and the host aliases the local runtimes publish. Nothing else.
    assert.doesNotThrow(() => checkEndpointLocality('kind-dev', 'https://127.0.0.1:6443', undefined));
    assert.doesNotThrow(() => checkEndpointLocality('docker-desktop', 'https://kubernetes.docker.internal:6443', undefined));
    assert.doesNotThrow(() => checkEndpointLocality('orbstack', 'https://0.0.0.0:26443', undefined));
    assert.doesNotThrow(() => checkEndpointLocality('k3d-dev', 'https://[::1]:6443', undefined));
  });

  it('refuses a remote endpoint even when the context name looks local', () => {
    assert.throws(
      () => checkEndpointLocality('minikube', 'https://prod.eks.amazonaws.com', undefined),
      new RegExp(ENDPOINT_OVERRIDE_ENV),
    );
  });

  it('refuses a PRIVATE/LAN endpoint too, unless the override names it exactly', () => {
    // "Private" means "not routable from the internet" — NOT "on this machine".
    // minikube's VM lives on 192.168.49.2, and so does the cluster on the office
    // LAN and the one at the far end of a VPN. Portler cannot tell them apart, so
    // it makes the user say which one they mean.
    const minikube = 'https://192.168.49.2:8443';
    assert.throws(() => checkEndpointLocality('minikube', minikube, undefined), /private\/LAN address/);
    assert.throws(() => checkEndpointLocality('minikube', minikube, undefined), new RegExp(ENDPOINT_OVERRIDE_ENV));
    assert.throws(() => checkEndpointLocality('kind-dev', 'https://10.4.0.9:6443', undefined), /refusing to use kubectl context/);

    // The exact URL, and nothing else, unlocks it.
    assert.doesNotThrow(() => checkEndpointLocality('minikube', minikube, minikube));
    assert.throws(() => checkEndpointLocality('minikube', minikube, 'https://192.168.49.3:8443'), /refusing to use/);
  });

  it('allows a remote endpoint only when the override names it EXACTLY', () => {
    const server = 'https://kube.internal.example.com:6443';
    assert.doesNotThrow(() => checkEndpointLocality('kind-dev', server, server));
    assert.throws(() => checkEndpointLocality('kind-dev', server, 'https://something.else'), /refusing to use kubectl context/);
  });

  it('FAILS CLOSED when the endpoint is unreadable, unparseable or empty', () => {
    // Previously a warning: the run continued against a cluster Portler could not
    // identify at all, on the strength of a context NAME. A tool that deletes
    // namespaces does not get to guess.
    assert.throws(() => checkEndpointLocality('kind-dev', null, undefined), /cannot tell which cluster it points at/);
    assert.throws(() => checkEndpointLocality('kind-dev', '', undefined), /cannot tell which cluster it points at/);
    assert.throws(() => checkEndpointLocality('kind-dev', '   ', undefined), /cannot tell which cluster it points at/);
    assert.throws(() => checkEndpointLocality('kind-dev', 'not a url', undefined), /could not be parsed/);
  });

  it('has no override for an endpoint it cannot read', () => {
    // The override names an exact URL; there is no URL here to name, so a stale
    // export cannot rubber-stamp an unidentifiable cluster.
    assert.throws(() => checkEndpointLocality('kind-dev', null, 'https://127.0.0.1:6443'), /has no override/);
    assert.throws(() => checkEndpointLocality('kind-dev', 'not a url', 'not a url'), /has no override/);
  });
});

describe('isNamespaceNotFound', () => {
  it('matches the API server\'s own NotFound answer for a namespace', () => {
    assert.equal(isNamespaceNotFound('Error from server (NotFound): namespaces "portler-app" not found'), true);
    assert.equal(isNamespaceNotFound('namespaces "portler-app" not found'), true);
  });

  it('does NOT treat a missing binary or credential helper as an absent namespace', () => {
    // THE REGRESSION. The old matcher was /\bnotfound\b|not found/i, so every
    // "not found" — a missing kubectl, a missing auth plugin — read as "the
    // namespace does not exist". That is the exact licence to create the
    // namespace and, later, to DELETE it: an operational failure would have been
    // laundered into an ownership claim.
    assert.equal(isNamespaceNotFound('bash: kubectl: command not found'), false);
    assert.equal(
      isNamespaceNotFound(
        'Unable to connect to the server: getting credentials: exec: executable gke-gcloud-auth-plugin not found',
      ),
      false,
    );
    assert.equal(isNamespaceNotFound('error: open /home/dev/.kube/config: no such file or directory'), false);
    assert.equal(isNamespaceNotFound('Error from server (Forbidden): namespaces "x" is forbidden'), false);
    assert.equal(isNamespaceNotFound('Unable to connect to the server: dial tcp: lookup api: no such host'), false);
    assert.equal(isNamespaceNotFound(''), false);
  });

  it('keeps a credential-helper failure an operational error all the way up', async () => {
    const missingPlugin: CommandResult = {
      code: 1,
      stdout: '',
      stderr: 'Unable to connect to the server: getting credentials: exec: executable aws-iam-authenticator not found',
    };

    const read = parseNamespaceRead(missingPlugin.code, missingPlugin.stdout, missingPlugin.stderr);
    assert.equal(read.status, 'error');

    // ...and the ownership gate refuses rather than deciding the namespace is free.
    const config = makeConfig();
    const { run } = fakeKubectl([missingPlugin]);
    await assert.rejects(ensureNamespaceClaimable(CLUSTER, config, run), /could not determine whether namespace/);

    // ...and a phase read throws instead of reporting "no namespace".
    const phase = fakeKubectl([missingPlugin]);
    await assert.rejects(getNamespacePhase(CLUSTER, config.k8sNamespace, phase.run), /could not read namespace/);
  });

  it('still reports a genuinely absent namespace as absent', async () => {
    const { run } = fakeKubectl([NS_NOT_FOUND]);
    assert.equal(await ensureNamespaceClaimable(CLUSTER, makeConfig(), run), 'absent');

    const phase = fakeKubectl([NS_NOT_FOUND]);
    assert.equal(await getNamespacePhase(CLUSTER, 'portler-myapp-abc', phase.run), null);
  });
});

describe('project ownership label', () => {
  it('is a collision-resistant digest, not the 32-bit name hash', () => {
    // The label is what authorizes `down k8s` to delete a namespace. Under the
    // old 32-bit FNV value, two project paths colliding could delete each other's
    // workloads (and a collision is brute-forceable in seconds).
    const value = projectLabels(makeConfig())[PROJECT_LABEL]!;

    assert.match(value, /^[0-9a-f]{32}$/, 'a 128-bit hex digest');
    assert.ok(value.length <= 63, 'a Kubernetes label value is limited to 63 characters');
  });

  it('is deterministic per project directory, and different for a different one', () => {
    const config = makeConfig();
    assert.equal(projectLabels(config)[PROJECT_LABEL], projectLabels(makeConfig())[PROJECT_LABEL]);
    assert.notEqual(
      projectLabels(config)[PROJECT_LABEL],
      projectLabels({ ...config, projectDir: '/home/dev/other' })[PROJECT_LABEL],
    );
  });
});

describe('Kubernetes service-name mapping', () => {
  it('rejects names that collapse onto one resource name', () => {
    assert.throws(() => k8sServiceNames(['foo_bar', 'foo-bar']), /both map to Kubernetes name "foo-bar"/);
  });

  it('validates the whole project even when this invocation selects only one colliding service', () => {
    const service = (name: string): ServiceConfig => ({
      name,
      cwd: '.',
      portEnv: [],
      env: {},
      host: '127.0.0.1',
      urlHost: 'localhost',
      protocol: 'http',
      preferDeclaredPort: false,
      dependsOn: [],
      docker: { image: `example/${name}`, containerName: name, volumes: [], env: {} },
    });
    const config = makeConfig({ foo_bar: service('foo_bar'), 'foo-bar': service('foo-bar') });

    assert.throws(() => validateK8sMode(config, ['foo_bar']), /both map to Kubernetes name "foo-bar"/);
  });
});

describe('deleteSelector', () => {
  const config = makeConfig();
  const projectHash = projectLabels(config)[PROJECT_LABEL];

  it('scopes a full delete to this project', () => {
    const selector = deleteSelector(config);
    assert.equal(selector, `${MANAGED_BY_LABEL}=portler,${PROJECT_LABEL}=${projectHash}`);
  });

  it('scopes a partial delete by project AND service name', () => {
    // `app in (api)` alone would also match another project's "api" Deployment
    // if the two ever shared a namespace.
    const selector = deleteSelector(config, ['api', 'web']);
    assert.ok(selector.includes(`${PROJECT_LABEL}=${projectHash}`), selector);
    assert.ok(selector.includes('app in (api,web)'), selector);
  });
});

describe('deleteResourceKinds', () => {
  it('preserves PersistentVolumeClaims by default', () => {
    // An ordinary `portler down k8s` must not destroy a database's data.
    const kinds = deleteResourceKinds(false);
    assert.equal(kinds, 'deployment,service');
    assert.ok(!kinds.includes('persistentvolumeclaim'));
  });

  it('deletes PVCs only when volume deletion is explicit', () => {
    assert.ok(deleteResourceKinds(true).includes('persistentvolumeclaim'));
  });
});

describe('port-forward supervisor spec', () => {
  const spec = {
    serviceName: 'api',
    k8sName: 'api',
    namespace: 'portler-myapp-abc',
    localPort: 52001,
    targetPort: 8080,
    address: '127.0.0.1',
    context: 'kind-dev',
  };

  it('pins the kubectl context on the port-forward too', () => {
    // Otherwise a context switch after `up k8s` would re-point the forward's
    // kubectl at a different cluster when it respawns after a pod restart.
    const args = portForwardArgs(spec);
    assert.deepEqual(args.slice(0, 2), ['--context', 'kind-dev']);
    assert.ok(args.includes('port-forward'));
  });

  it('rejects a spec with no context', () => {
    assert.equal(isForwardSpec(spec), true);
    assert.equal(isForwardSpec({ ...spec, context: '' }), false);
    const { context: _dropped, ...withoutContext } = spec;
    assert.equal(isForwardSpec(withoutContext), false);
  });
});
