import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ml_kem768 as mlKem768 } from '@noble/post-quantum/ml-kem.js';
import { Buffer } from 'buffer';

import { KemCiphertext } from './kem_ciphertext.js';
import type { PostQuantumPublicKey } from './post_quantum_public_key.js';

/** Byte length of a KEM shared secret, which is that of an ML-KEM-768 shared secret. */
export const KEM_SHARED_SECRET_SIZE_IN_BYTES = 32;

/** Number of fields a KEM shared secret takes in aztec-nr's `KemSharedSecret`: one per 31-byte chunk of the secret. */
export const KEM_SHARED_SECRET_SIZE_IN_FIELDS = Math.ceil(KEM_SHARED_SECRET_SIZE_IN_BYTES / (Fr.SIZE_IN_BYTES - 1));

/** Byte length of the seed of an encapsulation, which is all the randomness an ML-KEM-768 encapsulation draws on. */
export const KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES = mlKem768.lengths.msgRand!;

/** What encapsulating to a post-quantum public key yields. */
export type MlKemEncapsulation = {
  /**
   * The KEM shared secret, {@link KEM_SHARED_SECRET_SIZE_IN_BYTES} bytes that only whoever encapsulated and the
   * account the key belongs to know.
   */
  sharedSecret: Buffer;
  /** What the account the key belongs to recovers the shared secret from, with {@link mlKemDecapsulate}. */
  ciphertext: KemCiphertext;
};

/**
 * Encapsulates a KEM shared secret to `publicKey`.
 *
 * The encapsulation is fully determined by `publicKey` and `seed`: the same two always yield the same shared secret
 * and ciphertext. The shared secret is therefore only secret if `seed` is, so encapsulate with a fresh random seed
 * unless the encapsulation must be reproducible.
 *
 * @returns The encapsulation, or undefined if `publicKey` is not a valid ML-KEM-768 public key.
 * @throws If `seed` is not {@link KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES} bytes long.
 */
export function mlKemEncapsulate(publicKey: PostQuantumPublicKey, seed: Buffer): MlKemEncapsulation | undefined {
  if (seed.length !== KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES) {
    throw new Error(
      `A KEM encapsulation seed is ${KEM_ENCAPSULATION_SEED_SIZE_IN_BYTES} bytes long, got ${seed.length} bytes`,
    );
  }

  let encapsulation: { cipherText: Uint8Array; sharedSecret: Uint8Array };
  try {
    encapsulation = mlKem768.encapsulate(publicKey.toBuffer(), seed);
  } catch {
    // The library only reports a public key as invalid by throwing. A `PostQuantumPublicKey` always has the right
    // length, and so does the seed, which leaves a key with out of range coefficients as the one input it throws on.
    return undefined;
  }

  return {
    sharedSecret: Buffer.from(encapsulation.sharedSecret),
    ciphertext: KemCiphertext.fromBuffer(Buffer.from(encapsulation.cipherText)),
  };
}

/**
 * Recovers an encapsulation's KEM shared secret from its ciphertext.
 *
 * `secretKey` is the secret key of the ML-KEM-768 key pair whose public key was encapsulated to. A ciphertext that is
 * not that of an encapsulation to that public key does not fail: it yields a secret unrelated to any encapsulation's.
 */
export function mlKemDecapsulate(ciphertext: KemCiphertext, secretKey: Buffer): Buffer {
  return Buffer.from(mlKem768.decapsulate(ciphertext.toBuffer(), secretKey));
}
