import net from 'node:net';

function normalizeCheckHost(host: string): string {
  if (host === 'localhost') return '127.0.0.1';
  return host;
}

/** Resolve to true when nothing is currently bound to the given host:port. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.unref();
    server.on('error', () => resolve(false));
    server.listen({ port, host: normalizeCheckHost(host), exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
