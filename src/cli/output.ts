let failed = false;

/**
 * A reader may close Portler's output early (`portler restart | head -1`). Node then emits EPIPE as an 'error'
 * on process.stdout or process.stderr, which ends the process when nobody listens: a restart would stop services
 * and never start them again. Later writes fail the same way and are dropped.
 */
export function keepRunningWhenOutputCloses(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (!readerGone(error)) failed = true;
    });
  }
}

export function readerGone(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EPIPE' || error.code === 'ECONNRESET';
}

/** Whether a write failed for another reason than a closed reader, such as a full disk. */
export function outputFailed(): boolean {
  return failed;
}
