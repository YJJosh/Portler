import fs from 'node:fs/promises';
import path from 'node:path';

/** Raised when a JSON state file exists but cannot be parsed or fails validation. */
export class CorruptStateFileError extends Error {
  readonly filePath: string;

  constructor(filePath: string, description: string, cause: string, recoveryCommand = 'portler clean --force') {
    super(
      `invalid ${description}: ${filePath} (${cause}). ` +
        `Run "${recoveryCommand}" to reset ${recoveryCommand.includes('--global') ? 'the global registry' : "this project's runtime state"}.`,
    );
    this.name = 'CorruptStateFileError';
    this.filePath = filePath;
  }
}

/**
 * Read and JSON-parse a file, returning null when the file does not exist.
 * A malformed file raises CorruptStateFileError so callers (and `clean
 * --force`) can recover from it instead of dying on a raw SyntaxError.
 */
async function readJsonFile(filePath: string, description: string, recoveryCommand?: string): Promise<unknown | null> {
  let text: string;

  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CorruptStateFileError(filePath, description, (error as Error).message, recoveryCommand);
  }
}

/**
 * Read JSON and validate its runtime shape before returning typed data.
 * Throws for existing files with unsupported/corrupt shapes instead of
 * trusting a compile-time-only `as T` assertion.
 */
export async function readValidatedJsonFile<T>(
  filePath: string,
  description: string,
  validate: (value: unknown) => value is T,
  recoveryCommand?: string,
): Promise<T | null> {
  const value = await readJsonFile(filePath, description, recoveryCommand);
  if (value === null) return null;
  if (!validate(value)) throw new CorruptStateFileError(filePath, description, 'unexpected shape', recoveryCommand);
  return value;
}

/**
 * Like readValidatedJsonFile, but treats a corrupt file as absent (returning
 * null) instead of throwing. Used by recovery paths — `clean --force` and
 * `down` must still work when the file they are trying to clean up is the
 * very thing that is broken.
 */
export async function readValidatedJsonFileOrNull<T>(
  filePath: string,
  description: string,
  validate: (value: unknown) => value is T,
  recoveryCommand?: string,
): Promise<T | null> {
  try {
    return await readValidatedJsonFile(filePath, description, validate, recoveryCommand);
  } catch (error) {
    if (error instanceof CorruptStateFileError) return null;
    throw error;
  }
}

/**
 * Write pretty-printed JSON with a trailing newline, creating parent dirs.
 *
 * The write is atomic: content lands in a same-directory temp file that is
 * fsynced and then renamed over the target, so a crash (or a concurrent
 * reader) never observes a half-written state file. rename(2) is atomic
 * within a filesystem, and the temp file is a sibling to guarantee that.
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomSuffix()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  // Every failure path after the temp file exists must remove it, not just the
  // rename: a full disk (write), an I/O error (sync) or a failed close would
  // otherwise leave a `.pids.json.<pid>.<rand>.tmp` behind on every attempt,
  // and those accumulate in .portler/ forever.
  try {
    const handle = await fs.open(tempPath, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
