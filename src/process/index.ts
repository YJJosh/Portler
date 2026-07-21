export { identityVerdict, maySignal, readProcessStartToken } from './identity.ts';
export type { IdentityVerdict } from './identity.ts';
export { createLinePrinter, logsDir, prefixStream, serviceLogPath } from './logs.ts';
export {
  dockerLabelArgs,
  inspectResource,
  ownershipVerdict,
  PROJECT_LABEL,
  removeOwnedContainer,
  removeOwnedNetwork,
  SERVICE_LABEL,
} from './ownership.ts';
export type { Inspection, OwnershipVerdict, RemovalOutcome } from './ownership.ts';
export { isPidRunning, pidInfoFor, readPids, readPidsOrNull, runningServices, updatePids, writePids } from './pids.ts';
export { spawnService } from './spawn.ts';
export { signalDecision, stopServices } from './stop.ts';
export type { StopOptions, StopResult } from './stop.ts';
export { waitForForegroundServices } from './supervise.ts';
