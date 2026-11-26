import net from 'node:net';
import os from 'node:os';
import { usesTcp } from '../ports/transport.ts';
import { isObject, isString } from '../util/guards.ts';
import { normalizeIpAddress } from '../util/ip.ts';
import { isTailnetAddress, urlHostForm } from './tailnet.ts';
import { readTailscaleSelf, type TailscaleSelf } from './tailscale.ts';
import type { PidServiceInfo, PortlerConfig, ServiceConfig, ShareSettings } from '../types/index.ts';

export const SHARE_TARGETS = '"tailscale", "tailscale-dns", an IP address of this machine, or "none"';

function interfaceAddresses(): Set<string> {
  const found = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      const normalized = normalizeIpAddress(entry.address);
      if (normalized !== undefined) found.add(normalized);
    }
  }
  return found;
}

export interface ShareDependencies {
  tailscale?: () => Promise<TailscaleSelf>;
  localAddresses?: () => Set<string>;
}

/** Turns a `--share` value into the addresses to listen on. Reads Tailscale's status, changes nothing. */
export async function resolveShare(target: string, deps: ShareDependencies = {}): Promise<ShareSettings> {
  const local = (deps.localAddresses ?? interfaceAddresses)();

  if (target === 'tailscale' || target === 'tailscale-dns') {
    const self = await (deps.tailscale ?? readTailscaleSelf)();
    const addresses = self.addresses.map((ip) => normalizeIpAddress(ip)).filter((ip): ip is string => ip !== undefined && local.has(ip));
    if (addresses.length === 0) {
      throw new Error(
        `Tailscale gives this machine ${self.addresses.join(', ')}, but no network interface here has that address, so Portler cannot listen on it. ` +
          'This happens when tailscaled runs in userspace networking mode, or when Tailscale runs on the Windows side of WSL2.',
      );
    }
    if (target === 'tailscale-dns' && self.dnsName === undefined) {
      throw new Error('--share tailscale-dns needs MagicDNS, which is off for this tailnet; use "--share tailscale" for URLs with the Tailscale IP.');
    }
    const ipUrlHost = addresses.find((ip) => net.isIPv4(ip)) ?? addresses[0]!;
    const urlHost = target === 'tailscale-dns' ? self.dnsName! : ipUrlHost;
    const hostNames = [...addresses.map(urlHostForm), ...(self.dnsName !== undefined ? [self.dnsName] : [])];
    return { target, addresses, urlHost, hostNames, tailnetOnly: true };
  }

  const ip = normalizeIpAddress(target);
  if (ip === undefined) throw new Error(`--share expects ${SHARE_TARGETS}, got "${target}"`);
  if (ip === '0.0.0.0' || ip === '::') {
    throw new Error(`--share ${target} would listen on every network; give one address of this machine instead`);
  }
  if (ip.startsWith('127.') || ip === '::1') throw new Error(`--share ${target} is a loopback address, which other machines cannot reach`);
  if (!local.has(ip)) throw new Error(`--share ${target}: no network interface of this machine has that address`);
  return { target: ip, addresses: [ip], urlHost: ip, hostNames: [urlHostForm(ip)], tailnetOnly: isTailnetAddress(ip) };
}

export function isShareSettings(value: unknown): value is ShareSettings {
  return (
    isObject(value) &&
    isString(value.target) &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.every((ip) => isString(ip) && normalizeIpAddress(ip) !== undefined) &&
    isString(value.urlHost) &&
    Array.isArray(value.hostNames) &&
    value.hostNames.every(isString) &&
    typeof value.tailnetOnly === 'boolean'
  );
}

export function sameShare(a: ShareSettings, b: ShareSettings): boolean {
  return a.target === b.target && [...a.addresses].sort().join(',') === [...b.addresses].sort().join(',');
}

/** Whether `--share` gives this service's port a listener on the shared addresses. */
export function sharesPort(service: Pick<ServiceConfig, 'port' | 'share' | 'transport'>): boolean {
  return service.port !== undefined && service.share !== false && usesTcp(service);
}

/** Shared services get the shared url host; `localUrlHost` keeps the one this machine uses. */
export function applyShare(config: PortlerConfig, share: ShareSettings | undefined): PortlerConfig {
  if (share === undefined) return config;
  const services = Object.fromEntries(
    Object.entries(config.services).map(([name, service]) => [
      name,
      sharesPort(service) ? { ...service, localUrlHost: service.urlHost, urlHost: share.urlHost } : service,
    ]),
  );
  return { ...config, services, share };
}

/** The share of a live stack: one live entry with a share speaks for the stack. */
export function liveShare(liveEntries: readonly PidServiceInfo[]): ShareSettings | undefined {
  return liveEntries.find((entry) => entry.share !== undefined)?.share;
}

/**
 * The share a start uses. Without a request, a running stack's share is kept; a request has to match what
 * runs, since running services already hold env with their URLs. `replay` is restart's recorded share.
 */
export async function chooseShare(
  liveEntries: readonly PidServiceInfo[],
  request: string | undefined,
  replay?: ShareSettings,
  resolve: (target: string) => Promise<ShareSettings> = resolveShare,
): Promise<ShareSettings | undefined> {
  const running = liveShare(liveEntries);
  const runningUnshared = liveEntries.some((entry) => entry.share === undefined);
  const downFirst = 'run "portler down" first';

  if (replay !== undefined) {
    if (runningUnshared) throw new Error(`these services were started with --share ${replay.target}, but others are running without it; ${downFirst}`);
    if (running && !sameShare(running, replay)) {
      throw new Error(`these services were started with --share ${replay.target}, but the stack runs with --share ${running.target}; ${downFirst}`);
    }
    return replay;
  }
  if (request === undefined) return running;
  if (request === 'none') {
    if (running) throw new Error(`this stack is running with --share ${running.target}; ${downFirst} to run it unshared`);
    return undefined;
  }
  if (running) {
    const normalized = normalizeIpAddress(request) ?? request;
    if (running.target === normalized) return running;
    throw new Error(`this stack is running with --share ${running.target}; ${downFirst} to share it with --share ${request}`);
  }
  if (liveEntries.length > 0) throw new Error(`this stack is running without --share; ${downFirst}, then start it with --share ${request}`);
  return resolve(request);
}
