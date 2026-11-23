// Leads a shared service's process group: runs the service's shell command as its child, in the same group, and
// listens on the shared addresses while it runs. argv: the JSON ShareForwardSpec, the shell command, and the service's
// NODE_OPTIONS if it has any.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { isShareForwardSpec, startShareForwarder } from './forwarder.ts';

let spec: unknown;
try {
  spec = JSON.parse(process.argv[2] ?? '');
} catch {
  spec = undefined;
}
const command = process.argv[3];
if (!isShareForwardSpec(spec) || !command) {
  process.stderr.write('portler share: invalid arguments\n');
  process.exit(1);
}

const env = { ...process.env };
if (process.argv[4] !== undefined) env.NODE_OPTIONS = process.argv[4];

// Not detached: the shell joins this process's group, so a group signal reaches it, and this process, the leader
// Portler recorded, exits only after it. Signals are left to the shell; this process follows its exit.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => {});
const child = spawn(command, { shell: true, stdio: 'inherit', env });
const forwarder = startShareForwarder(spec);

// Ends as the service ended, so Portler sees the same exit. Signals that dump core end it with 128+n instead.
const RERAISED = new Set<NodeJS.Signals>(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGKILL', 'SIGPIPE', 'SIGUSR1', 'SIGUSR2', 'SIGALRM']);
const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
  void forwarder.close();
  if (signal && RERAISED.has(signal)) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1));
};

child.on('error', (error) => {
  process.stderr.write(`portler share: cannot start the service: ${error.message}\n`);
  finish(127, null);
});
child.on('exit', finish);
