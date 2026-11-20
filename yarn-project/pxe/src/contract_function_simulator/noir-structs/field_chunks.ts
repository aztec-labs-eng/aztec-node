import type { Fr } from '@aztec-labs/foundation/curves/bn254';

/**
 * Wire form of the Aztec.nr structs that hold bytes in 31-byte chunks, one per field: `PostQuantumPublicKey`,
 * `KemSharedSecret` and `KemCiphertext`.
 *
 * It holds the fields as they are rather than the value they encode, because a contract can pass fields that encode
 * no valid value, and the oracle that receives them handles that case itself.
 */
export type FieldChunks = { fields: Fr[] };
