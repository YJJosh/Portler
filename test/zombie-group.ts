import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * A process group that outlives its leader as a zombie, the way a service's
 * group does under a PID 1 that does not reap orphans.
 *
 * A helper starts `command` in a new group of its own (detached) and then stops
 * itself with SIGSTOP. A stopped parent cannot reap, so once the group's leader
 * exits it stays a zombie until `release` resumes the helper. `pgid` is the
 * leader's pid, which is also the group id.
 */
export interface ZombieGroup {
  pgid: number;
  /** Resume the helper and wait for it to reap the leader and exit. */
  release: () => Promise<void>;
}

export async function startZombieGroup(command: string, args: string[]): Promise<ZombieGroup> {
  const script = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(args)}, { detached: true, stdio: 'ignore' });`,
    "process.stdout.write(child.pid + '\\n', () => process.kill(process.pid, 'SIGSTOP'));",
  ].join('\n');
  const helper = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(helper.stdout!, 'data');
  const pgid = Number(String(chunk).trim());

  return {
    pgid,
    release: async () => {
      if (helper.exitCode !== null || helper.signalCode !== null) return;
      // Let the helper reap its child and exit on its own. A kill right after
      // the SIGCONT could land before it reaps, and the zombie would go to
      // PID 1, which may never reap it.
      helper.kill('SIGCONT');
      const fallback = setTimeout(() => helper.kill('SIGKILL'), 2000);
      await once(helper, 'exit');
      clearTimeout(fallback);
    },
  };
}

/** Poll `check` until it returns `want` or the timeout passes; returns the last answer. */
export async function waitFor(check: () => boolean, want: boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let answer = check();
  while (answer !== want && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    answer = check();
  }
  return answer;
}
