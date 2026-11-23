// Started in the background by a shared service's own shell, so it lives in the service's process group and
// stops with it. argv[2] is the JSON ShareForwardSpec.
import { isShareForwardSpec, startShareForwarder } from './forwarder.ts';

const PARENT_POLL_MS = 1_000;

let spec: unknown;
try {
  spec = JSON.parse(process.argv[2] ?? '');
} catch {
  spec = undefined;
}
if (!isShareForwardSpec(spec)) {
  process.stderr.write('portler share: invalid forward spec\n');
  process.exit(1);
}

startShareForwarder(spec);
// The service's shell is the parent; once it is gone the service is too, and its port may go to someone else.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
}, PARENT_POLL_MS);
