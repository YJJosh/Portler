import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultHealthcheck, isTcpReady } from '../readiness/index.ts';
import { urlHostForm } from './tailnet.ts';
import type { ServiceAssignment, ServiceConfig, ShareSettings } from '../types/index.ts';

const SHARE_READY_TIMEOUT_MS = 10_000;
const SHARE_POLL_MS = 200;
const SELF_PROBE_MS = 500;

const ownAddressChecks = new Map<string, Promise<boolean>>();

// Connects to a throwaway listener on port 0, so it never races a forwarder for the shared port.
async function reachesOwnAddress(address: string): Promise<boolean> {
  const server = net.createServer((socket) => socket.destroy());
  server.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: address, port: 0 }, resolve);
    });
  } catch {
    return true;
  }
  try {
    return await isTcpReady(address, (server.address() as net.AddressInfo).port, SELF_PROBE_MS);
  } finally {
    server.close();
  }
}

/**
 * The shared addresses this machine can check by connecting to itself. macOS cannot connect to its own Tailscale
 * IPv6 address, though other devices can, so a check from here would report it as down.
 */
export async function checkableAddresses(addresses: readonly string[], reaches = reachesOwnAddress): Promise<string[]> {
  const results = await Promise.all(
    addresses.map((address) => {
      let check = ownAddressChecks.get(address);
      if (check === undefined) {
        check = reaches(address);
        ownAddressChecks.set(address, check);
      }
      return check;
    }),
  );
  return addresses.filter((_, index) => results[index]);
}

/** Waits until the shared address accepts connections on the service's port, so the printed URL works once `up`
 * returns. Warns instead of failing: the service itself is up, and only the sharing is missing. */
export async function waitForSharedPort(
  share: ShareSettings,
  assignment: ServiceAssignment,
  exited: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SHARE_READY_TIMEOUT_MS;
  const waiting = new Set(await checkableAddresses(share.addresses));
  while (waiting.size > 0 && Date.now() < deadline) {
    signal?.throwIfAborted();
    if (exited()) return;
    for (const address of [...waiting]) {
      if (await isTcpReady(address, assignment.port, 1_000, 0, signal)) waiting.delete(address);
    }
    if (waiting.size > 0) await delay(SHARE_POLL_MS, undefined, { signal });
  }
  if (waiting.size === 0) return;
  const where = [...waiting].map((address) => `${urlHostForm(address)}:${assignment.port}`).join(', ');
  process.stderr.write(`[portler] warning: ${assignment.name} runs, but ${where} does not answer, so it is not shared there\n`);
}

/** Only a tcp or http readiness check proves the service accepts connections, which the forwarder waits for. */
export function readinessProvesListening(service: ServiceConfig, assignment: ServiceAssignment): boolean {
  const type = (service.healthcheck ?? defaultHealthcheck(service, assignment)).type;
  return type === 'tcp' || type === 'http';
}
