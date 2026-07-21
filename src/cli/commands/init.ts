import fs from 'node:fs/promises';
import path from 'node:path';
import { pathExists } from '../../util/fs.ts';
import { SAMPLE_PORTLER_YML } from '../sample.ts';

export async function commandInit(): Promise<number> {
  const filePath = path.join(process.cwd(), 'portler.yml');
  if (await pathExists(filePath)) throw new Error('portler.yml already exists');

  await fs.writeFile(filePath, SAMPLE_PORTLER_YML, 'utf8');
  process.stdout.write('[portler] wrote portler.yml\n');
  return 0;
}
