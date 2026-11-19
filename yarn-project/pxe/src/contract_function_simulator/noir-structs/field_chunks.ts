import type { Fr } from '@aztec-labs/foundation/curves/bn254';

/**
 * Wire form of the Aztec.nr structs that hold bytes in 31-byte chunks, one per field: `PostQuantumPublicKey`,
 * `KemSharedSecret` and `KemCiphertext`.
 *
 * The fields cross the oracle boundary undecoded, since those a contract passes in may not be the encoding of any
 * bytes.
 */
export type FieldChunks = { fields: Fr[] };
