import { setTimeout as delay } from 'node:timers/promises';
import { defaultHealthcheck, isTcpReady } from '../readiness/index.ts';
import { urlHostForm } from './tailnet.ts';
import type { ServiceAssignment, ServiceConfig, ShareSettings } from '../types/index.ts';

const SHARE_READY_TIMEOUT_MS = 10_000;
const SHARE_POLL_MS = 200;

/** Waits until the shared address accepts connections on the service's port, so the printed URL works once `up`
 * returns. Warns instead of failing: the service itself is up, and only the sharing is missing. */
export async function waitForSharedPort(
  share: ShareSettings,
  assignment: ServiceAssignment,
  exited: () => boolean,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SHARE_READY_TIMEOUT_MS;
  const waiting = new Set(share.addresses);
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
  process.stderr.write(`[portler] warning: ${assignment.name} runs, but ${where} does not answer; see "portler logs ${assignment.name}" for the [portler share] lines\n`);
}

/** Only a tcp or http readiness check proves the service accepts connections, which the forwarder waits for. */
export function readinessProvesListening(service: ServiceConfig, assignment: ServiceAssignment): boolean {
  const type = (service.healthcheck ?? defaultHealthcheck(service, assignment)).type;
  return type === 'tcp' || type === 'http';
}
