import { runCommand, type CommandRunner } from '../util/exec.ts';
import { isObject, isString } from '../util/guards.ts';

/** What `--share tailscale` needs from `tailscale status --json`. */
export interface TailscaleSelf {
  addresses: string[];
  /** The node's MagicDNS name without the trailing dot; undefined when the tailnet has MagicDNS off. */
  dnsName?: string;
}

// The Mac App Store and standalone apps ship the CLI inside the app bundle, not on PATH.
const MACOS_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const STATUS_TIMEOUT_MS = 10_000;

function cliCandidates(): string[] {
  const override = process.env.PORTLER_TAILSCALE;
  if (override) return [override];
  return process.platform === 'darwin' ? ['tailscale', MACOS_APP_CLI] : ['tailscale'];
}

/** Read-only: runs `tailscale status --json` and never changes the node. Throws when Tailscale is missing,
 * not running or not logged in. */
export async function readTailscaleSelf(run: CommandRunner = runCommand): Promise<TailscaleSelf> {
  let result;
  let cli = '';
  for (const candidate of cliCandidates()) {
    cli = candidate;
    try {
      result = await run(candidate, ['status', '--json'], undefined, AbortSignal.timeout(STATUS_TIMEOUT_MS));
    } catch {
      throw new Error(`"${candidate} status --json" did not answer within ${STATUS_TIMEOUT_MS / 1_000}s; is tailscaled running?`);
    }
    if (result.code !== -1) break;
  }
  if (!result || result.code === -1) {
    throw new Error('--share tailscale needs the Tailscale CLI ("tailscale"), which was not found. Install Tailscale and log in, or set PORTLER_TAILSCALE to the CLI path.');
  }

  let status: unknown;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`"${cli} status --json" failed: ${detail}`);
  }
  return parseTailscaleStatus(status);
}

export function parseTailscaleStatus(status: unknown): TailscaleSelf {
  if (!isObject(status)) throw new Error('tailscale status --json returned no status object');
  const state = status.BackendState;
  if (state !== 'Running') {
    const hint = state === 'NeedsLogin' ? 'log in with "tailscale up"' : 'start it with "tailscale up"';
    throw new Error(`Tailscale is not running (state: ${isString(state) ? state : 'unknown'}); ${hint}, then try again.`);
  }
  const self = isObject(status.Self) ? status.Self : {};
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : Array.isArray(status.TailscaleIPs) ? status.TailscaleIPs : [];
  const addresses = ips.filter(isString);
  if (addresses.length === 0) throw new Error('Tailscale is running but this machine has no Tailscale address yet; try again in a moment.');

  const tailnet = isObject(status.CurrentTailnet) ? status.CurrentTailnet : {};
  const rawName = isString(self.DNSName) ? self.DNSName.replace(/\.$/, '') : '';
  const magicDns = tailnet.MagicDNSEnabled === true && rawName.includes('.');
  return { addresses, ...(magicDns ? { dnsName: rawName.toLowerCase() } : {}) };
}
