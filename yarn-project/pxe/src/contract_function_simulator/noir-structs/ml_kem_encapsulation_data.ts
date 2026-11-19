import type { FieldChunks } from './field_chunks.js';

/** Wire form of an ML-KEM encapsulation: TypeScript counterpart of a `(KemSharedSecret, KemCiphertext)` in Aztec.nr. */
export type MlKemEncapsulationData = {
  kemSharedSecret: FieldChunks;
  kemCiphertext: FieldChunks;
};
