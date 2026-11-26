import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultHealthcheck, isTcpReady } from '../readiness/index.ts';
import { urlHostForm } from './tailnet.ts';
import type { ServiceAssignment, ServiceConfig, ShareSettings } from '../types/index.ts';

const SHARE_READY_TIMEOUT_MS = 10_000;
const SHARE_POLL_MS = 200;
const SELF_PROBE_MS = 500;

const ownAddressChecks = new Map<string, Promise<boolean>>();

// Port 1, where nothing listens: a refusal proves the path works, only silence that it does not. It binds no
// port, so it never takes one a forwarder is about to listen on.
function reachesOwnAddress(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port: 1 });
    const done = (reached: boolean): void => {
      socket.destroy();
      resolve(reached);
    };
    socket.setTimeout(SELF_PROBE_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(true));
  });
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
  if (waiting.size === 0 && !exited()) {
    const where = share.addresses.map((address) => `${urlHostForm(address)}:${assignment.port}`).join(', ');
    process.stderr.write(`[portler] ${assignment.name}: this machine cannot connect to ${where} to check it; other devices may need a moment\n`);
    return;
  }
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
