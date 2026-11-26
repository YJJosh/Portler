/**
 * A reader may close Portler's output early (`portler restart | head -1`). Node then emits EPIPE as an 'error'
 * on process.stdout or process.stderr, which ends the process when nobody listens: a restart would stop services
 * and never start them again. The stream is destroyed after the error, so later writes do nothing.
 */
export function keepRunningWhenOutputCloses(): void {
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
}
