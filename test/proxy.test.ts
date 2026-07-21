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
  };

  it('accepts a complete options object', () => {
    assert.equal(isProxyServerOptions(valid), true);
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
