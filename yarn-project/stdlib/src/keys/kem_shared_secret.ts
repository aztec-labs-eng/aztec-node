import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Buffer } from 'buffer';

import { bufferToFieldChunks } from '../abi/buffer.js';

/**
 * The secret an ML-KEM-768 encapsulation establishes.
 *
 * TypeScript counterpart of aztec-nr's `KemSharedSecret`, whose fields are this secret's
 * {@link KemSharedSecret.toFields} encoding.
 */
export class KemSharedSecret {
  /** Byte length of an ML-KEM-768 shared secret. */
  static readonly SIZE_IN_BYTES = 32;
  /** Length of the {@link KemSharedSecret.toFields} encoding: one field per 31-byte chunk of the secret. */
  static readonly SIZE_IN_FIELDS = Math.ceil(KemSharedSecret.SIZE_IN_BYTES / (Fr.SIZE_IN_BYTES - 1));

  private constructor(private readonly secret: Buffer) {}

  /**
   * Wraps the raw bytes of an ML-KEM-768 shared secret.
   *
   * @throws If `buffer` is not {@link KemSharedSecret.SIZE_IN_BYTES} bytes long.
   */
  static fromBuffer(buffer: Buffer): KemSharedSecret {
    if (buffer.length !== KemSharedSecret.SIZE_IN_BYTES) {
      throw new Error(`A KEM shared secret is ${KemSharedSecret.SIZE_IN_BYTES} bytes long, got ${buffer.length} bytes`);
    }
    return new KemSharedSecret(Buffer.from(buffer));
  }

  toBuffer(): Buffer {
    return Buffer.from(this.secret);
  }

  /**
   * Encodes the secret as {@link KemSharedSecret.SIZE_IN_FIELDS} fields, the layout aztec-nr's `KemSharedSecret` holds.
   */
  toFields(): Fr[] {
    return bufferToFieldChunks(this.secret);
  }
}
