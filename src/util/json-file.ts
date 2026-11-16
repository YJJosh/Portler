import fs from 'node:fs/promises';
import path from 'node:path';

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

/** Null when the file does not exist; CorruptStateFileError, not a raw SyntaxError, when malformed. */
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

/** Null when the file does not exist; throws CorruptStateFileError when it fails `validate`. */
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

/** Treats a corrupt file as absent, so `clean --force` and `down` work when the file is what is broken. */
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
 * Atomic, creating parent dirs: a fsynced temp file in the same directory is
 * renamed over the target (rename(2) is atomic within one filesystem), so no
 * reader or crash sees a half-written file.
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });

  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomSuffix()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  // Any failure after the temp file exists removes it, or temp files pile up in .portler/.
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
