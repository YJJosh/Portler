import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { sleep } from '../util/sleep.ts';

/**
 * Everything one supervised `kubectl port-forward` needs, serialized as JSON
 * and handed to the hidden `portler __k8s-forward` command.
 */
export interface ForwardSpec {
  serviceName: string;
  /** Sanitized Kubernetes Service name to forward to. */
  k8sName: string;
  namespace: string;
  localPort: number;
  targetPort: number;
  address: string;
  /** kubectl context, pinned by the parent so a context switch cannot redirect us. */
  context: string;
}

/** Give up after this many consecutive quick failures. */
const MAX_RESTARTS = 5;
/** A forward that survived this long resets the restart budget. */
const STABLE_RUN_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;

export function isForwardSpec(value: unknown): value is ForwardSpec {
  if (typeof value !== 'object' || value === null) return false;
  const spec = value as Record<string, unknown>;
  return (
    typeof spec.serviceName === 'string' &&
    typeof spec.k8sName === 'string' &&
    typeof spec.namespace === 'string' &&
    typeof spec.localPort === 'number' &&
    typeof spec.targetPort === 'number' &&
    typeof spec.address === 'string' &&
    typeof spec.context === 'string' &&
    spec.context !== ''
  );
}

export function portForwardArgs(spec: ForwardSpec): string[] {
  return [
    '--context',
    spec.context,
    'port-forward',
    `service/${spec.k8sName}`,
    `${spec.localPort}:${spec.targetPort}`,
    '--namespace',
    spec.namespace,
    '--address',
    spec.address,
  ];
}

function runForwardOnce(spec: ForwardSpec): { child: ChildProcess; exited: Promise<number> } {
  // stdio inherit: kubectl's output flows through the supervisor's own stdio,
  // which the parent `portler up k8s` either pipes with a [service] prefix
  // (foreground) or ignores (detached).
  const child = spawn('kubectl', portForwardArgs(spec), { stdio: 'inherit' });

  const exited = new Promise<number>((resolve) => {
    child.on('error', (error) => {
      process.stderr.write(`port-forward failed to start: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });

  return { child, exited };
}

/**
 * Supervise a `kubectl port-forward`, re-spawning it when it dies unexpectedly
 * (pod restarts kill the forward) with capped exponential backoff. Runs as its
 * own process (`portler __k8s-forward <json>`) so detached stacks keep their
 * forwards alive after `up k8s -d` exits; its pid is the one tracked in
 * pids.json, so `portler down` signals the whole supervisor+kubectl group.
 */
export async function runForwardSupervisor(spec: ForwardSpec): Promise<number> {
  let shuttingDown = false;
  let current: ChildProcess | null = null;

  const onSignal = (): void => {
    shuttingDown = true;
    current?.kill('SIGTERM');
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let attempts = 0;

  for (;;) {
    // A signal can arrive during exponential backoff, when there is no current
    // kubectl child to terminate. Do not start a brand-new forward afterwards.
    if (shuttingDown) return 0;

    const startedAt = Date.now();
    const { child, exited } = runForwardOnce(spec);
    current = child;
    const code = await exited;
    current = null;

    if (shuttingDown) return 0;

    if (Date.now() - startedAt >= STABLE_RUN_MS) attempts = 0;
    attempts += 1;

    if (attempts > MAX_RESTARTS) {
      process.stderr.write(`port-forward for ${spec.serviceName} failed ${MAX_RESTARTS} times in a row; giving up\n`);
      return 1;
    }

    const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
    process.stderr.write(
      `port-forward exited (code ${code}); reconnecting in ${delayMs / 1_000}s (attempt ${attempts}/${MAX_RESTARTS})\n`,
    );
    await sleep(delayMs);
    if (shuttingDown) return 0;
  }
}
