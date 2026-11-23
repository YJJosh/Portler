import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseArgs } from '../src/cli/args.ts';
import { planRestart } from '../src/cli/commands/restart.ts';
import { shareRequest } from '../src/cli/commands/up.ts';
import { loadConfig } from '../src/config/index.ts';
import { localUrl, resolveEnvValue } from '../src/env/index.ts';
import { allocateAssignments } from '../src/ports/allocate.ts';
import { buildProxyServerOptions } from '../src/proxy/spawn.ts';
import { isAllowedHost } from '../src/proxy/server.ts';
import { shareForwardSpec, shareWrapperSpawn } from '../src/share/command.ts';
import { startShareForwarder, upstreamHosts } from '../src/share/forwarder.ts';
import { applyShare, chooseShare, isShareSettings, resolveShare } from '../src/share/settings.ts';
import { isTailnetAddress } from '../src/share/tailnet.ts';
import { parseTailscaleStatus, readTailscaleSelf } from '../src/share/tailscale.ts';
import type { PidServiceInfo, PortlerConfig, ServiceAssignment, ServiceConfig, ShareSettings } from '../src/types/index.ts';

const TAILSCALE: ShareSettings = {
  target: 'tailscale',
  addresses: ['100.64.0.4', 'fd7a:115c:a1e0::4'],
  urlHost: '100.64.0.4',
  hostNames: ['100.64.0.4', '[fd7a:115c:a1e0::4]', 'lap.tail.example'],
  tailnetOnly: true,
};

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BackendState: 'Running',
    Self: { DNSName: 'Lap.tail.example.', TailscaleIPs: ['100.64.0.4', 'fd7a:115c:a1e0::4'] },
    CurrentTailnet: { MagicDNSEnabled: true },
    ...overrides,
  };
}

function service(name: string, overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name,
    cwd: '.',
    port: 4000,
    portEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    preferDeclaredPort: false,
    dependsOn: [],
    ...overrides,
  };
}

function config(services: ServiceConfig[]): PortlerConfig {
  return {
    filePath: '/project/portler.yml',
    projectDir: '/project',
    useEnv: [],
    env: {},
    host: '127.0.0.1',
    urlHost: 'localhost',
    protocol: 'http',
    portRange: { start: 52300, end: 52999 },
    preferDeclaredPort: false,
    dockerNetwork: 'portler-net',
    volumeRoot: '/project',
    volumes: [],
    k8sNamespace: 'portler-test',
    services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  };
}

function entry(share?: ShareSettings): PidServiceInfo {
  return { pid: 1, command: 'x', cwd: '/project', startedAt: '', ...(share ? { share } : {}) };
}

describe('tailnet addresses', () => {
  it('recognizes the Tailscale and Headscale ranges only', () => {
    assert.equal(isTailnetAddress('100.64.0.4'), true);
    assert.equal(isTailnetAddress('100.127.255.254'), true);
    assert.equal(isTailnetAddress('::ffff:100.64.0.4'), true);
    assert.equal(isTailnetAddress('fd7a:115c:a1e0::4'), true);
    assert.equal(isTailnetAddress('100.128.0.1'), false);
    assert.equal(isTailnetAddress('10.10.10.5'), false);
    assert.equal(isTailnetAddress('127.0.0.1'), false);
    assert.equal(isTailnetAddress('fd7a:115c:a1e1::4'), false);
    assert.equal(isTailnetAddress('not-an-ip'), false);
  });
});

describe('tailscale status', () => {
  it('reads the addresses and the MagicDNS name without its trailing dot', () => {
    assert.deepEqual(parseTailscaleStatus(status()), { addresses: ['100.64.0.4', 'fd7a:115c:a1e0::4'], dnsName: 'lap.tail.example' });
  });

  it('leaves the name out when the tailnet has MagicDNS off', () => {
    assert.equal(parseTailscaleStatus(status({ CurrentTailnet: { MagicDNSEnabled: false } })).dnsName, undefined);
  });

  it('refuses a node that is not running or has no address', () => {
    assert.throws(() => parseTailscaleStatus(status({ BackendState: 'NeedsLogin' })), /not running \(state: NeedsLogin\); log in/);
    assert.throws(() => parseTailscaleStatus(status({ BackendState: 'Stopped' })), /not running \(state: Stopped\)/);
    assert.throws(() => parseTailscaleStatus(status({ Self: { TailscaleIPs: [] } })), /no Tailscale address/);
  });

  it('says so when the CLI is missing', async () => {
    const previous = process.env.PORTLER_TAILSCALE;
    process.env.PORTLER_TAILSCALE = '/nonexistent/tailscale';
    try {
      await assert.rejects(readTailscaleSelf(async () => ({ code: -1, stdout: '', stderr: '' })), /needs the Tailscale CLI/);
      await assert.rejects(readTailscaleSelf(async () => ({ code: 1, stdout: '', stderr: 'failed to connect' })), /failed: failed to connect/);
    } finally {
      if (previous === undefined) delete process.env.PORTLER_TAILSCALE;
      else process.env.PORTLER_TAILSCALE = previous;
    }
  });
});

describe('resolveShare', () => {
  const tailscale = async () => parseTailscaleStatus(status());
  const local = () => new Set(['127.0.0.1', '100.64.0.4', 'fd7a:115c:a1e0::4', '192.168.1.20']);

  it('shares on the Tailscale addresses with IP URLs by default', async () => {
    assert.deepEqual(await resolveShare('tailscale', { tailscale, localAddresses: local }), {
      target: 'tailscale',
      addresses: ['100.64.0.4', 'fd7a:115c:a1e0::4'],
      urlHost: '100.64.0.4',
      hostNames: ['100.64.0.4', '[fd7a:115c:a1e0::4]', 'lap.tail.example'],
      tailnetOnly: true,
    });
  });

  it('uses the MagicDNS name for tailscale-dns, and refuses it without MagicDNS', async () => {
    assert.equal((await resolveShare('tailscale-dns', { tailscale, localAddresses: local })).urlHost, 'lap.tail.example');
    const noDns = async () => parseTailscaleStatus(status({ CurrentTailnet: {} }));
    await assert.rejects(resolveShare('tailscale-dns', { tailscale: noDns, localAddresses: local }), /needs MagicDNS/);
  });

  it('skips Tailscale addresses no interface has, and refuses when none is left', async () => {
    const v4Only = () => new Set(['100.64.0.4']);
    assert.deepEqual((await resolveShare('tailscale', { tailscale, localAddresses: v4Only })).addresses, ['100.64.0.4']);
    await assert.rejects(resolveShare('tailscale', { tailscale, localAddresses: () => new Set(['127.0.0.1']) }), /userspace networking/);
  });

  it('accepts one address of this machine, and filters peers only for a tailnet one', async () => {
    const lan = await resolveShare('192.168.1.20', { localAddresses: local });
    assert.deepEqual(lan, { target: '192.168.1.20', addresses: ['192.168.1.20'], urlHost: '192.168.1.20', hostNames: ['192.168.1.20'], tailnetOnly: false });
    assert.equal((await resolveShare('100.64.0.4', { localAddresses: local })).tailnetOnly, true);
    await assert.rejects(resolveShare('0.0.0.0', { localAddresses: local }), /every network/);
    await assert.rejects(resolveShare('::', { localAddresses: local }), /every network/);
    await assert.rejects(resolveShare('127.0.0.1', { localAddresses: local }), /loopback/);
    await assert.rejects(resolveShare('10.1.2.3', { localAddresses: local }), /no network interface/);
    await assert.rejects(resolveShare('lan', { localAddresses: local }), /expects "tailscale"/);
  });
});

describe('chooseShare', () => {
  const resolve = async (target: string): Promise<ShareSettings> => ({ ...TAILSCALE, target });

  it('starts private by default and shares on request when nothing runs', async () => {
    assert.equal(await chooseShare([], undefined, undefined, resolve), undefined);
    assert.equal(await chooseShare([], 'none', undefined, resolve), undefined);
    assert.equal((await chooseShare([], 'tailscale', undefined, resolve))?.target, 'tailscale');
  });

  it('keeps a running stack share, with or without the same request', async () => {
    assert.equal(await chooseShare([entry(TAILSCALE)], undefined, undefined, resolve), TAILSCALE);
    assert.equal(await chooseShare([entry(TAILSCALE)], 'tailscale', undefined, resolve), TAILSCALE);
  });

  it('refuses to change the share of a running stack', async () => {
    await assert.rejects(chooseShare([entry()], 'tailscale', undefined, resolve), /running without --share; run "portler down" first/);
    await assert.rejects(chooseShare([entry(TAILSCALE)], 'none', undefined, resolve), /running with --share tailscale/);
    await assert.rejects(chooseShare([entry(TAILSCALE)], '192.168.1.20', undefined, resolve), /running with --share tailscale/);
  });

  it('replays a restart share unless what still runs disagrees', async () => {
    assert.equal(await chooseShare([], undefined, TAILSCALE, resolve), TAILSCALE);
    assert.equal(await chooseShare([entry(TAILSCALE)], undefined, TAILSCALE, resolve), TAILSCALE);
    await assert.rejects(chooseShare([entry()], undefined, TAILSCALE, resolve), /others are running without it/);
  });

  it('validates recorded settings', () => {
    assert.equal(isShareSettings(TAILSCALE), true);
    assert.equal(isShareSettings({ ...TAILSCALE, addresses: [] }), false);
    assert.equal(isShareSettings({ ...TAILSCALE, addresses: ['nope'] }), false);
  });
});

describe('applyShare', () => {
  it('moves shared TCP services to the shared url host and keeps the local one', () => {
    const shared = applyShare(
      config([service('api'), service('db', { share: false }), service('game', { transport: 'udp' }), service('worker', { port: undefined })]),
      TAILSCALE,
    );
    assert.equal(shared.share, TAILSCALE);
    assert.deepEqual([shared.services.api!.urlHost, shared.services.api!.localUrlHost], ['100.64.0.4', 'localhost']);
    for (const name of ['db', 'game', 'worker']) {
      assert.equal(shared.services[name]!.urlHost, 'localhost', name);
      assert.equal(shared.services[name]!.localUrlHost, undefined, name);
    }
  });

  it('builds a forward spec only for a shared port on a specific host', () => {
    const shared = applyShare(config([service('api'), service('wide', { host: '0.0.0.0' }), service('db', { share: false })]), TAILSCALE);
    const assignment = (name: string, host = '127.0.0.1'): ServiceAssignment => ({ name, port: 52400, host, urlHost: '100.64.0.4', protocol: 'http', url: '' });
    assert.deepEqual(shareForwardSpec(shared, shared.services.api!, assignment('api')), {
      service: 'api', port: 52400, upstream: '127.0.0.1', addresses: TAILSCALE.addresses, tailnetOnly: true,
    });
    assert.equal(shareForwardSpec(shared, shared.services.wide!, assignment('wide', '0.0.0.0')), undefined);
    assert.equal(shareForwardSpec(shared, shared.services.db!, assignment('db')), undefined);
    assert.equal(shareForwardSpec(config([service('api')]), service('api'), assignment('api')), undefined);
  });

  it('wraps the service command and moves NODE_OPTIONS aside for the wrapper', () => {
    const spec = { service: 'api', port: 52400, upstream: '127.0.0.1', addresses: ['100.64.0.4'], tailnetOnly: true };
    const wrapper = shareWrapperSpawn(spec, 'npm run dev', { PATH: '/bin', NODE_OPTIONS: '--require ./otel.js' });
    assert.equal(wrapper.file, process.execPath);
    assert.match(wrapper.args.at(-3)!, /share[/\\]daemon\.(ts|js)$/);
    assert.deepEqual(wrapper.args.slice(-2), [JSON.stringify(spec), 'npm run dev']);
    assert.equal(wrapper.env.NODE_OPTIONS, undefined);
    assert.equal(wrapper.env.PORTLER_SHARE_SERVICE_NODE_OPTIONS, '--require ./otel.js');
  });

  it('drops a shared address the service binds itself', () => {
    const shared = applyShare(config([service('api', { host: '100.64.0.4' }), service('only', { host: '100.64.0.4' })]), TAILSCALE);
    const assignment: ServiceAssignment = { name: 'api', port: 52400, host: '100.64.0.4', urlHost: '100.64.0.4', protocol: 'http', url: '' };
    assert.deepEqual(shareForwardSpec(shared, shared.services.api!, assignment)?.addresses, ['fd7a:115c:a1e0::4']);
    const v4Only = applyShare(config([service('only', { host: '100.64.0.4' })]), { ...TAILSCALE, addresses: ['100.64.0.4'] });
    assert.equal(shareForwardSpec(v4Only, v4Only.services.only!, assignment), undefined);
  });
});

describe('shared references and URLs', () => {
  const api: ServiceAssignment = {
    name: 'api', port: 52400, host: '127.0.0.1', urlHost: '100.64.0.4', localUrlHost: 'localhost', protocol: 'http', url: 'http://100.64.0.4:52400',
  };

  it('gives url the shared address and local_url and address the local one', () => {
    assert.equal(localUrl(api), 'http://localhost:52400');
    assert.equal(localUrl({ ...api, localUrlHost: undefined, url: 'http://localhost:52400' }), 'http://localhost:52400');
    assert.equal(resolveEnvValue('${api.url}', { api }), 'http://100.64.0.4:52400');
    assert.equal(resolveEnvValue('${api.local_url}', { api }), 'http://localhost:52400');
    assert.equal(resolveEnvValue('${api.address}', { api }), 'localhost:52400');
    assert.equal(resolveEnvValue('${api.url_host}', { api }), '100.64.0.4');
  });

  it('lets the proxy listen on the shared addresses and answer for their names', () => {
    const proxyAssignment: ServiceAssignment = { ...api, name: 'proxy', port: 52401, url: 'http://100.64.0.4:52401' };
    const options = buildProxyServerOptions(
      { trustedProxies: [], routes: [{ prefix: '/', service: 'api' }], allowedHosts: [] },
      { api, proxy: proxyAssignment },
      TAILSCALE,
    );
    assert.deepEqual(options.shareAddresses, TAILSCALE.addresses);
    assert.equal(options.tailnetOnly, true);
    for (const host of ['100.64.0.4:52401', '[fd7a:115c:a1e0::4]:52401', 'lap.tail.example:52401', 'localhost:52401']) {
      assert.equal(isAllowedHost(host, options.allowedHosts), true, host);
    }
    assert.equal(isAllowedHost('attacker.example:52401', options.allowedHosts), false);
  });

  it('marks routes to share: false services, and keeps a wildcard proxy off the shared addresses', () => {
    const db: ServiceAssignment = { name: 'db', port: 52402, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: 'http://localhost:52402' };
    const proxy = (host: string): ServiceAssignment => ({ ...api, name: 'proxy', host, port: 52401, url: '' });
    const proxyConfig = { trustedProxies: [], routes: [{ prefix: '/db', service: 'db' }, { prefix: '/', service: 'api' }], allowedHosts: [] };
    const options = buildProxyServerOptions(proxyConfig, { api, db, proxy: proxy('127.0.0.1') }, TAILSCALE);
    assert.deepEqual(options.routes.map((route) => [route.service, route.local ?? false]), [['db', true], ['api', false]]);
    assert.equal(buildProxyServerOptions(proxyConfig, { api, db, proxy: proxy('0.0.0.0') }, TAILSCALE).shareAddresses, undefined);
    assert.equal(buildProxyServerOptions(proxyConfig, { api, db, proxy: proxy('127.0.0.1') }).routes[0]!.local, undefined);
  });
});

describe('--share flag', () => {
  it('parses both spellings and refuses a missing or repeated value', () => {
    assert.equal(parseArgs(['--share', 'tailscale'], 'up').share, 'tailscale');
    assert.equal(parseArgs(['--share=100.64.0.4', 'api'], 'up').share, '100.64.0.4');
    assert.throws(() => parseArgs(['--share'], 'up'), /requires a target/);
    assert.throws(() => parseArgs(['--share', '-d'], 'up'), /requires a target/);
    assert.throws(() => parseArgs(['--share', 'a', '--share', 'b'], 'up'), /given twice/);
  });

  it('takes PORTLER_SHARE as the default and refuses --share with --prod', () => {
    const previous = process.env.PORTLER_SHARE;
    process.env.PORTLER_SHARE = 'tailscale';
    try {
      assert.equal(shareRequest({}), 'tailscale');
      assert.equal(shareRequest({ share: 'none' }), 'none');
      assert.equal(shareRequest({ prod: true }), undefined);
      assert.throws(() => shareRequest({ prod: true, share: 'tailscale' }), /does not apply with --prod/);
    } finally {
      if (previous === undefined) delete process.env.PORTLER_SHARE;
      else process.env.PORTLER_SHARE = previous;
    }
  });
});

describe('restart and --share', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-share-'));
    await fs.writeFile(
      path.join(projectDir, 'portler.yml'),
      ['services:', '  db:', '    command: node -e ""', '    port: 3001', '  api:', '    command: node -e ""', '    port: 3000', '    depends_on: [db]', ''].join('\n'),
    );
  });

  afterEach(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it('replays the recorded share and refuses a stack that is only partly shared', async () => {
    const rawConfig = await loadConfig(projectDir);
    const plan = (running: Record<string, PidServiceInfo>) =>
      planRestart({
        rawConfig,
        running,
        runningNow: new Set(['db', 'api']),
        stopping: ['api'],
        involved: ['db', 'api'],
        starting: ['api'],
        requestedMode: 'local',
        modeExplicit: false,
        prod: undefined,
        setup: undefined,
        images: undefined,
        volumeSetGiven: false,
      });
    const shared = plan({ db: entry(TAILSCALE), api: entry(TAILSCALE) });
    assert.equal(shared.share, TAILSCALE);
    assert.deepEqual(shared.replayed, ['--share tailscale']);
    assert.equal(plan({ db: entry(), api: entry() }).share, undefined);
    assert.throws(() => plan({ db: entry(), api: entry(TAILSCALE) }), /api was started with --share tailscale and db without it/);
  });

  it('refuses to replay a share into production', async () => {
    const rawConfig = await loadConfig(projectDir);
    assert.throws(
      () =>
        planRestart({
          rawConfig,
          running: { db: entry(TAILSCALE), api: entry(TAILSCALE) },
          runningNow: new Set(['db', 'api']),
          stopping: ['db', 'api'],
          involved: ['db', 'api'],
          starting: ['db', 'api'],
          requestedMode: 'local',
          modeExplicit: false,
          prod: true,
          setup: undefined,
          images: undefined,
          volumeSetGiven: false,
        }),
      /does not apply with --prod/,
    );
  });

  it('loads share: false and rejects other values', async () => {
    await fs.writeFile(path.join(projectDir, 'portler.yml'), ['services:', '  db:', '    command: x', '    port: 3001', '    share: false', ''].join('\n'));
    assert.equal((await loadConfig(projectDir)).services.db!.share, false);
    await fs.writeFile(path.join(projectDir, 'portler.yml'), ['services:', '  db:', '    command: x', '    port: 3001', '    share: maybe', ''].join('\n'));
    await assert.rejects(loadConfig(projectDir), /services\.db\.share must be true or false/);
  });
});

function listen(host: string, port = 0, handler?: (socket: net.Socket) => void): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      (handler ?? ((client: net.Socket) => client.end(`peer ${client.remoteAddress}\n`)))(socket);
    });
    server.once('error', reject);
    server.listen({ host, port }, () => resolve(server));
  });
}

function request(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(data.trim()));
    socket.on('close', () => resolve(data.trim()));
    socket.on('error', () => resolve(`error`));
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function portOf(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

// 127.0.0.2 stands in for the shared address: Linux routes all of 127/8 to lo, macOS only has 127.0.0.1.
describe('share forwarder', { skip: process.platform !== 'linux' }, () => {
  it('listens only once the service does, and pipes from the shared address', async () => {
    const probe = await listen('127.0.0.1');
    const port = portOf(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const forwarder = startShareForwarder({ service: 'api', port, upstream: '127.0.0.1', addresses: ['127.0.0.2'], tailnetOnly: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(await request('127.0.0.2', port), 'error', 'nothing listens before the service does');
      const upstream = await listen('127.0.0.1', port);
      try {
        await waitFor(async () => (await request('127.0.0.2', port)).startsWith('peer'));
        assert.equal(await request('127.0.0.2', port), 'peer 127.0.0.2', 'the service sees the shared address, not loopback');
      } finally {
        upstream.close();
      }
    } finally {
      await forwarder.close();
    }
  });

  it('drops peers outside the tailnet when tailnetOnly is set', async () => {
    const upstream = await listen('127.0.0.1');
    const port = portOf(upstream);
    const forwarder = startShareForwarder({ service: 'api', port, upstream: '127.0.0.1', addresses: ['127.0.0.2'], tailnetOnly: true });
    try {
      await waitFor(async () => (await request('127.0.0.2', port)) !== 'error');
      assert.equal(await request('127.0.0.2', port), '', 'a loopback peer is not a tailnet peer');
    } finally {
      await forwarder.close();
      upstream.close();
    }
  });

  it('keeps a half-closed client connection open for the reply', async () => {
    const upstream = await listen('127.0.0.1', 0, (socket) => {
      socket.on('end', () => socket.end('reply\n'));
      socket.resume();
    });
    const port = portOf(upstream);
    const forwarder = startShareForwarder({ service: 'api', port, upstream: '127.0.0.1', addresses: ['127.0.0.2'], tailnetOnly: false });
    try {
      await waitFor(async () => new Promise((resolve) => {
        const probe = net.connect({ host: '127.0.0.2', port }, () => { probe.destroy(); resolve(true); });
        probe.on('error', () => resolve(false));
      }));
      const reply = await new Promise<string>((resolve) => {
        const socket = net.connect({ host: '127.0.0.2', port, allowHalfOpen: true }, () => socket.end('request\n'));
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('close', () => resolve(data.trim()));
        socket.on('error', () => resolve('error'));
      });
      assert.equal(reply, 'reply');
    } finally {
      await forwarder.close();
      upstream.close();
    }
  });

  it('tries both loopback families for a localhost service', () => {
    assert.deepEqual(upstreamHosts('localhost'), ['127.0.0.1', '::1']);
    assert.deepEqual(upstreamHosts('10.0.0.5'), ['10.0.0.5']);
  });
});

describe('share wrapper', () => {
  const daemon = path.join(import.meta.dirname, '..', 'src', 'share', 'daemon.ts');
  const spec = JSON.stringify({ service: 'api', port: 52499, upstream: '127.0.0.1', addresses: ['127.0.0.1'], tailnetOnly: false });
  const run = (command: string, env: NodeJS.ProcessEnv = process.env) =>
    spawn(process.execPath, ['--experimental-strip-types', daemon, spec, command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env });
  const exit = (child: ReturnType<typeof run>) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) => {
      let out = '';
      child.stdout!.on('data', (chunk) => (out += chunk));
      child.on('close', (code, signal) => resolve({ code, signal, out: out.trim() }));
    });

  it('exits with the exit code of the service command', async () => {
    assert.equal((await exit(run('exit 3'))).code, 3);
  });

  it('gives the service its own NODE_OPTIONS back', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PORTLER_SHARE_SERVICE_NODE_OPTIONS: '--max-old-space-size=64' };
    delete env.NODE_OPTIONS;
    const result = await exit(run('printf "%s" "$NODE_OPTIONS"; printf "|%s" "$PORTLER_SHARE_SERVICE_NODE_OPTIONS"', env));
    assert.deepEqual([result.code, result.out], [0, '--max-old-space-size=64|']);
  });

  it('stops with its group and exits after the service, by its signal', async () => {
    const child = run('sleep 30');
    const done = exit(child);
    await new Promise((resolve) => setTimeout(resolve, 800));
    process.kill(-child.pid!, 'SIGTERM');
    assert.equal((await done).signal, 'SIGTERM');
  });
});

describe('port allocation with --share', { skip: process.platform !== 'linux' }, () => {
  let globalDir: string;
  let previousGlobalDir: string | undefined;

  beforeEach(async () => {
    previousGlobalDir = process.env.PORTLER_GLOBAL_DIR;
    globalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'portler-test-share-registry-'));
    process.env.PORTLER_GLOBAL_DIR = globalDir;
  });

  afterEach(async () => {
    if (previousGlobalDir === undefined) delete process.env.PORTLER_GLOBAL_DIR;
    else process.env.PORTLER_GLOBAL_DIR = previousGlobalDir;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('skips a port that is free on loopback but taken on the shared address', async () => {
    const taken = await listen('127.0.0.2');
    const port = portOf(taken);
    try {
      const base = config([service('api')]);
      const local = { ...base, portRange: { start: port, end: port + 50 } };
      const shared = applyShare(local, { ...TAILSCALE, addresses: ['127.0.0.2'], urlHost: '127.0.0.2' });
      const state = {
        version: 1 as const, project: base.projectDir, updatedAt: '',
        services: { api: { name: 'api', port, host: '127.0.0.1', urlHost: 'localhost', protocol: 'http', url: '' } },
      };
      const assignments = await allocateAssignments(shared, state, ['api'], new Set());
      assert.notEqual(assignments.api!.port, port);
      assert.equal(assignments.api!.url, `http://127.0.0.2:${assignments.api!.port}`);
      assert.equal(assignments.api!.localUrlHost, 'localhost');
    } finally {
      taken.close();
    }
  });
});
