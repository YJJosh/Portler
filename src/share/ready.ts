import { setTimeout as delay } from 'node:timers/promises';
import { isTcpReady } from '../readiness/index.ts';
import type { ServiceAssignment, ShareSettings } from '../types/index.ts';

const SHARE_READY_TIMEOUT_MS = 10_000;
const SHARE_POLL_MS = 200;

/** Waits until the shared address accepts connections on the service's port, so the printed URL works once `up`
 * returns. Warns instead of failing: the service itself is up, and only the sharing is missing. */
export async function waitForSharedPort(share: ShareSettings, assignment: ServiceAssignment, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + SHARE_READY_TIMEOUT_MS;
  const address = share.addresses[0]!;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await isTcpReady(address, assignment.port, 1_000, 0, signal)) return;
    await delay(SHARE_POLL_MS, undefined, { signal });
  }
  process.stderr.write(
    `[portler] warning: ${assignment.name} runs, but ${address.includes(':') ? `[${address}]` : address}:${assignment.port} does not answer; ` +
      `see "portler logs ${assignment.name}" for the [portler share] lines\n`,
  );
}
