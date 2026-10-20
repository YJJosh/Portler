import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, describe, it } from 'node:test';
import { hostnameOf, isAllowedHost, isProxyServerOptions, matchRoute, startProxyServer } from '../src/proxy/server.ts';
import type { ProxyServerOptions, ProxyTarget } from '../src/proxy/server.ts';

describe('hostnameOf', () => {
  it('strips the port', () => {
    assert.equal(hostnameOf('localhost:52001'), 'localhost');
    assert.equal(hostnameOf('example.com'), 'example.com');
  });

  it('handles bracketed IPv6 literals', () => {
    assert.equal(hostnameOf('[::1]:52001'), '[::1]');
    assert.equal(hostnameOf('[::1]'), '[::1]');
  });

  it('lowercases and trims', () => {
    assert.equal(hostnameOf('  LocalHost:80 '), 'localhost');
  });
});

describe('isAllowedHost', () => {
  it('allows loopback names unconditionally', () => {
    for (const host of ['localhost:52001', '127.0.0.1:52001', '127.0.0.5', '[::1]:52001', 'app.localhost']) {
      assert.equal(isAllowedHost(host, []), true, host);
    }
  });

  it('allows the project url_host and any configured extra hosts', () => {
    assert.equal(isAllowedHost('myapp.test', ['myapp.test']), true);
    assert.equal(isAllowedHost('MyApp.Test:52001', ['myapp.test']), true);
  });

  it('BLOCKS a DNS-rebinding request carrying an attacker hostname', () => {
    // attacker.com briefly resolves to 127.0.0.1, so the browser connects to the
    // proxy — but it still sends `Host: attacker.com`, which the browser cannot
    // forge away. Refusing it is what stops a remote page reading the responses
    // of every service behind the proxy.
    assert.equal(isAllowedHost('attacker.com', []), false);
    assert.equal(isAllowedHost('attacker.com:52001', ['myapp.test']), false);
    assert.equal(isAllowedHost('evil.localhost.attacker.com', []), false);
  });

  it('does not treat a non-loopback IP as safe', () => {
    assert.equal(isAllowedHost('10.0.0.5', []), false);
    assert.equal(isAllowedHost('192.168.1.10:52001', []), false);
  });

  it('requires a valid 127/8 IP literal rather than a numeric-looking hostname', () => {
    assert.equal(isAllowedHost('127.0.0.999', []), false);
    assert.equal(isAllowedHost('127.0.0.1.999', []), false);
  });

  it('rejects malformed authorities even with an otherwise allowed hostname', () => {
    for (const host of ['localhost:80@evil.example', 'localhost:invalid', 'localhost:99999', 'localhost/path', 'localhost, evil.example', '[::1]extra', 'https://myapp.test']) {
      assert.equal(isAllowedHost(host, ['myapp.test']), false, host);
    }
  });

  it('allows a missing Host header (HTTP/1.0 clients, never a browser attack)', () => {
    assert.equal(isAllowedHost(undefined, []), true);
    assert.equal(isAllowedHost('', []), true);
  });
});

describe('isProxyServerOptions', () => {
  const valid: ProxyServerOptions = {
    host: '127.0.0.1',
    port: 52000,
    routes: [{ prefix: '/', service: 'web', host: '127.0.0.1', port: 52001 }],
    allowedHosts: ['localhost'],
    trustedProxies: [],
  };

  it('accepts a complete options object', () => {
    assert.equal(isProxyServerOptions(valid), true);
  });

  it('rejects missing or invalid trust configuration', () => {
    const { trustedProxies: _dropped, ...withoutTrust } = valid;
    assert.equal(isProxyServerOptions(withoutTrust), false);
    assert.equal(isProxyServerOptions({ ...valid, trustedProxies: ['*'] }), false);
  });

  it('rejects options without allowedHosts, so the daemon cannot start unguarded', () => {
    const { allowedHosts: _dropped, ...withoutHosts } = valid;
    assert.equal(isProxyServerOptions(withoutHosts), false);
  });
});

describe('matchRoute', () => {
  const routes: ProxyTarget[] = [
    { prefix: '/api', service: 'api', host: '127.0.0.1', port: 1 },
    { prefix: '/', service: 'web', host: '127.0.0.1', port: 2 },
  ];

  it('matches on path-segment boundaries only', () => {
    assert.equal(matchRoute(routes, '/api')?.service, 'api');
    assert.equal(matchRoute(routes, '/api/users')?.service, 'api');
    assert.equal(matchRoute(routes, '/api?q=1')?.service, 'api');
    assert.equal(matchRoute(routes, '/apifoo')?.service, 'web');
  });
});

describe('proxy server host checking (end to end)', () => {
  const servers: Array<http.Server | net.Server> = [];

  after(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
  });

  async function startStack(): Promise<number> {
    const upstream = http.createServer((_request, response) => {
      response.statusCode = 200;
      response.end('upstream ok');
    });
    servers.push(upstream);
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream.listen(0, '127.0.0.1', () => resolve((upstream.address() as net.AddressInfo).port));
    });

    const proxy = await startProxyServer({
      host: '127.0.0.1',
      port: 0,
      routes: [{ prefix: '/', service: 'web', host: '127.0.0.1', port: upstreamPort }],
      allowedHosts: ['myapp.test'],
      trustedProxies: [],
    });
    servers.push(proxy);

    return (proxy.address() as net.AddressInfo).port;
  }

  /** Send a request with an explicit Host header, bypassing DNS entirely. */
  function requestWithHost(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path: '/', method: 'GET', headers: { host: hostHeader } },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on('error', reject);
      request.end();
    });
  }

  it('forwards requests whose Host is a loopback name', async () => {
    const port = await startStack();
    const response = await requestWithHost(port, `localhost:${port}`);

    assert.equal(response.status, 200);
    assert.equal(response.body, 'upstream ok');
  });

  it('forwards requests whose Host is a configured allowed host', async () => {
    const port = await startStack();
    const response = await requestWithHost(port, 'myapp.test');

    assert.equal(response.status, 200);
  });

  it('rejects a rebound request with 403 and never reaches the upstream', async () => {
    const port = await startStack();
    const response = await requestWithHost(port, 'attacker.com');

    assert.equal(response.status, 403);
    assert.ok(!response.body.includes('upstream ok'), 'the upstream response must not leak');
    assert.match(response.body, /DNS-rebinding protection/);
  });

  it('rejects a rebound WebSocket upgrade too', async () => {
    // WebSockets are not covered by the same-origin policy, so an unchecked
    // Host here would reopen the hole the request path closes.
    const port = await startStack();

    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET / HTTP/1.1\r\nHost: attacker.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => socket.destroy(), 1_000);
    });

    assert.match(raw, /^HTTP\/1\.1 403 Forbidden/);
  });
});

describe('proxy forwarding trust boundary (real HTTP and WebSocket upgrades)', () => {
  const servers: http.Server[] = [];
  after(async () => {
    for (const server of servers.reverse()) await new Promise((resolve) => server.close(resolve));
  });

  async function stack(trustedProxies: string[], host = '127.0.0.1'): Promise<number> {
    const upstream = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
    upstream.on('upgrade', (req, socket) => {
      // Capture the real upgrade head without needing a WebSocket dependency.
      const body = JSON.stringify(req.headers);
      socket.end(`HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const proxy = await startProxyServer({
      host,
      port: 0,
      routes: [{ prefix: '/', service: 'web', host: '127.0.0.1', port: (upstream.address() as net.AddressInfo).port }],
      allowedHosts: ['app.example', 'edge.internal'],
      trustedProxies,
    });
    servers.push(proxy);
    return (proxy.address() as net.AddressInfo).port;
  }

  async function send(port: number, upgrade: boolean, headers: Record<string, string>, host = '127.0.0.1') {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, host, () => {
        const lines = ['GET / HTTP/1.1', 'Host: edge.internal', `Connection: ${upgrade ? 'Upgrade' : 'close'}`];
        if (upgrade) lines.push('Upgrade: websocket', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13');
        lines.push(...Object.entries(headers).map(([key, value]) => `${key}: ${value}`));
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });
      let data = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('proxy request timed out')));
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    return { status: Number(raw.split(' ')[1]), headers: raw.includes('200 OK') ? JSON.parse(raw.split('\r\n\r\n')[1]!) as http.IncomingHttpHeaders : {} };
  }

  const original = {
    'X-Forwarded-For': '198.51.100.7, 2001:db8::8',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'app.example:443',
    Forwarded: 'for=attacker;proto=http;host=evil.example',
    'X-Real-IP': '203.0.113.99',
    'X-Forwarded-Port': '666',
  };

  function assertDropped(headers: http.IncomingHttpHeaders) {
    for (const name of ['forwarded', 'x-real-ip', 'x-forwarded-port']) assert.equal(headers[name], undefined, name);
  }

  for (const upgrade of [false, true]) {
    const protocol = upgrade ? 'WebSocket' : 'HTTP';
    it(`${protocol}: strips spoofed metadata from untrusted loopback, including duplicate headers`, async () => {
      const port = await stack([]);
      const { status, headers } = await send(port, upgrade, { ...original, 'x-forwarded-for': '192.0.2.99', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' });
      assert.equal(status, 200);
      assert.equal(headers['x-forwarded-for'], '127.0.0.1');
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.equal(headers['x-forwarded-host'], 'edge.internal');
      assert.equal(headers.host, 'edge.internal');
      assertDropped(headers);
    });

    it(`${protocol}: preserves a trusted HTTPS secure origin and validated client chain`, async () => {
      const port = await stack(['::ffff:127.0.0.1']);
      const { status, headers } = await send(port, upgrade, original);
      assert.equal(status, 200);
      assert.equal(headers['x-forwarded-for'], '198.51.100.7, 2001:db8::8, 127.0.0.1');
      assert.equal(`${headers['x-forwarded-proto']}://${headers['x-forwarded-host']}`, 'https://app.example:443');
      assert.equal(headers.host, 'edge.internal', 'transport Host remains preserved');
      assertDropped(headers);
    });

    it(`${protocol}: preserves trusted HTTP too, but ignores Forwarded-only metadata`, async () => {
      const port = await stack(['127.0.0.1']);
      const { headers } = await send(port, upgrade, { ...original, 'X-Forwarded-Proto': 'http' });
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.equal(headers['x-forwarded-host'], 'app.example:443');
      const fallback = await send(port, upgrade, { Forwarded: 'for=198.51.100.7;proto=https;host=app.example', 'X-Real-IP': '198.51.100.7' });
      assert.equal(fallback.headers['x-forwarded-for'], '127.0.0.1');
      assert.equal(fallback.headers['x-forwarded-proto'], 'http');
      assert.equal(fallback.headers['x-forwarded-host'], 'edge.internal');
      assertDropped(fallback.headers);
    });

    it(`${protocol}: trusts only the exact peer, not other loopback addresses`, async () => {
      const port = await stack(['127.0.0.2']);
      const { headers } = await send(port, upgrade, original);
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.equal(headers['x-forwarded-host'], 'edge.internal');
      assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    });

    it(`${protocol}: ignores malformed, duplicate, unsupported and unallowed trusted metadata`, async () => {
      const port = await stack(['127.0.0.1']);
      for (const badHost of ['evil.example', 'app.example@evil.example', 'app.example/path', 'app.example:99999', 'app.example, evil.example']) {
        const { headers } = await send(port, upgrade, { ...original, 'X-Forwarded-Host': badHost, 'X-Forwarded-For': '198.51.100.7, unknown', 'X-Forwarded-Proto': 'https, http' });
        assert.equal(headers['x-forwarded-host'], 'edge.internal', badHost);
        assert.equal(headers['x-forwarded-for'], '127.0.0.1');
        assert.equal(headers['x-forwarded-proto'], 'http');
        assertDropped(headers);
      }
      const { headers } = await send(port, upgrade, { ...original, 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' });
      assert.equal(headers['x-forwarded-host'], 'edge.internal', 'duplicate forwarded host is not a single authority');
      assert.equal(headers['x-forwarded-proto'], 'http', 'duplicate proto is not a single scheme');
    });

    it(`${protocol}: validates all chain entries and combines valid repeated X-Forwarded-For`, async () => {
      const port = await stack(['127.0.0.1']);
      for (const badIp of ['unknown', '"198.51.100.7"', '198.51.100.7:123', '[2001:db8::1]', 'fe80::1%lo0', 'example.com', '']) {
        const { headers } = await send(port, upgrade, { ...original, 'X-Forwarded-For': `198.51.100.7, ${badIp}` });
        assert.equal(headers['x-forwarded-for'], '127.0.0.1', badIp);
        assert.equal(headers['x-forwarded-proto'], 'https', 'other valid fields survive independently');
      }
      const { headers } = await send(port, upgrade, { ...original, 'x-forwarded-for': '203.0.113.5' });
      assert.equal(headers['x-forwarded-for'], '198.51.100.7, 2001:db8::8, 203.0.113.5, 127.0.0.1');
    });

    it(`${protocol}: ignores trusted forwarding fields nominated as hop-by-hop`, async () => {
      const port = await stack(['127.0.0.1']);
      const { headers } = await send(port, upgrade, { ...original, Connection: `${upgrade ? 'Upgrade' : 'close'}, X-Forwarded-Proto, X-Forwarded-Host, X-Forwarded-For` });
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.equal(headers['x-forwarded-host'], 'edge.internal');
      assert.equal(headers['x-forwarded-for'], '127.0.0.1');
    });

    it(`${protocol}: a trusted forwarded host cannot bypass a forbidden transport Host`, async () => {
      const port = await stack(['127.0.0.1']);
      const result = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, headers: { ...original, host: 'evil.example', ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket' } : {}) } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(result, 403);
    });

    it(`${protocol}: supports an IPv6 exact peer with equivalent spelling`, async () => {
      const port = await stack(['0:0:0:0:0:0:0:1'], '::1');
      const { headers } = await send(port, upgrade, original, '::1');
      assert.equal(headers['x-forwarded-proto'], 'https');
      assert.equal(headers['x-forwarded-for'], '198.51.100.7, 2001:db8::8, ::1');
    });

    it(`${protocol}: recognizes an IPv4-mapped socket peer against an IPv4 allowlist`, async () => {
      const port = await stack(['127.0.0.1'], '::');
      const { headers } = await send(port, upgrade, original);
      assert.equal(headers['x-forwarded-proto'], 'https');
      assert.equal(headers['x-forwarded-for'], '198.51.100.7, 2001:db8::8, ::ffff:127.0.0.1');
    });
  }
});
