import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader } from '@aztec-labs/foundation/serialize';
import { VerificationKeyAsFields, VerificationKeyData } from '@aztec-labs/stdlib/vks';
import { promises as fs } from 'fs';
import * as path from 'path';

import { VK_FILENAME } from '../bb/file_names.js';

/**
 * Reads the verification key data stored at the specified location and parses into a VerificationKeyData
 * @param vkDirectoryPath - The directory containing the verification key data files
 * @returns The verification key data
 */
export async function extractVkData(vkDirectoryPath: string): Promise<VerificationKeyData> {
  const rawBinary = await fs.readFile(path.join(vkDirectoryPath, VK_FILENAME));

  // Convert binary to field elements (32 bytes per field)
  const numFields = rawBinary.length / Fr.SIZE_IN_BYTES;
  const reader = BufferReader.asReader(rawBinary);
  const fields = reader.readArray(numFields, Fr);

  const vkAsFields = await VerificationKeyAsFields.fromKey(fields);
  return new VerificationKeyData(vkAsFields, rawBinary);
}
