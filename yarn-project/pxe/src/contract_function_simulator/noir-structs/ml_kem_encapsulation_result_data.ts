import type { FieldChunks } from './field_chunks.js';

/** Wire form of aztec-nr's `MlKemEncapsulationResult`. */
export type MlKemEncapsulationResultData = {
  sharedSecret: FieldChunks;
  ciphertext: FieldChunks;
};
