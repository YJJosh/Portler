// Proxy process spawned by `up`, tracked and stopped like a service. argv[2] is the
// JSON-encoded ProxyServerOptions.
import { isProxyServerOptions, startProxyServer, startProxyShareServers } from './server.ts';

function fail(message: string): never {
  process.stderr.write(`portler proxy: ${message}\n`);
  process.exit(1);
}

function parseOptions(rawOptions: string | undefined): unknown {
  if (!rawOptions) fail('missing options argument');
  try {
    return JSON.parse(rawOptions) as unknown;
  } catch (error) {
    fail(`invalid options JSON: ${(error as Error).message}`);
  }
}

const options = parseOptions(process.argv[2]);
if (!isProxyServerOptions(options)) fail('invalid proxy options');

try {
  const server = await startProxyServer(options);
  server.on('error', (error) => fail(error.message));
  process.stdout.write(`listening on http://${options.host}:${options.port}\n`);
  for (const shared of await startProxyShareServers(options)) {
    shared.on('error', (error) => fail(error.message));
    const address = shared.address();
    if (address && typeof address === 'object') process.stdout.write(`shared on ${address.address}:${address.port}\n`);
  }
  for (const route of options.routes) {
    process.stdout.write(`route ${route.prefix} -> ${route.service} (${route.host}:${route.port})\n`);
  }
} catch (error) {
  fail((error as Error).message);
}
