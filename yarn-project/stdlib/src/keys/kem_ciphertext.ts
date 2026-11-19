import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ml_kem768 as mlKem768 } from '@noble/post-quantum/ml-kem.js';
import { Buffer } from 'buffer';

import { bufferFromExactFieldChunks, bufferToFieldChunks } from '../abi/buffer.js';

/**
 * The ciphertext of an ML-KEM-768 encapsulation.
 *
 * It is what whoever encapsulated to an account's post-quantum public key hands that account, for them to recover the
 * encapsulation's KEM shared secret. It reveals nothing about the secret to anyone else.
 *
 * TypeScript counterpart of aztec-nr's `KemCiphertext`, whose fields are this ciphertext's
 * {@link KemCiphertext.toFields} encoding.
 */
export class KemCiphertext {
  /** Byte length of an ML-KEM-768 ciphertext. */
  static readonly SIZE_IN_BYTES = mlKem768.lengths.cipherText!;
  /** Length of the {@link KemCiphertext.toFields} encoding: one field per 31-byte chunk of the ciphertext. */
  static readonly SIZE_IN_FIELDS = Math.ceil(KemCiphertext.SIZE_IN_BYTES / (Fr.SIZE_IN_BYTES - 1));

  private constructor(private readonly ciphertext: Buffer) {}

  /**
   * Wraps the raw bytes of an ML-KEM-768 ciphertext.
   *
   * @throws If `buffer` is not {@link KemCiphertext.SIZE_IN_BYTES} bytes long.
   */
  static fromBuffer(buffer: Buffer): KemCiphertext {
    if (buffer.length !== KemCiphertext.SIZE_IN_BYTES) {
      throw new Error(`A KEM ciphertext is ${KemCiphertext.SIZE_IN_BYTES} bytes long, got ${buffer.length} bytes`);
    }
    return new KemCiphertext(Buffer.from(buffer));
  }

  /**
   * Decodes a ciphertext from its {@link KemCiphertext.toFields} encoding.
   *
   * @throws If `fields` is not the {@link KemCiphertext.toFields} encoding of a ciphertext.
   */
  static fromFields(fields: Fr[]): KemCiphertext {
    return KemCiphertext.fromBuffer(bufferFromExactFieldChunks(fields, KemCiphertext.SIZE_IN_BYTES, 'KEM ciphertext'));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.ciphertext);
  }

  /**
   * Encodes the ciphertext as {@link KemCiphertext.SIZE_IN_FIELDS} fields, the layout aztec-nr's `KemCiphertext`
   * holds.
   */
  toFields(): Fr[] {
    return bufferToFieldChunks(this.ciphertext);
  }
}
