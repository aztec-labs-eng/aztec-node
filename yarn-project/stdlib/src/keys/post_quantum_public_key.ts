import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ml_kem768 as mlKem768 } from '@noble/post-quantum/ml-kem.js';
import { Buffer } from 'buffer';

import { bufferFromExactFieldChunks, bufferToFieldChunks } from '../abi/buffer.js';

/**
 * An account's post-quantum public key.
 *
 * TypeScript counterpart of aztec-nr's `PostQuantumPublicKey`, whose fields are this key's
 * {@link PostQuantumPublicKey.toFields} encoding.
 */
export class PostQuantumPublicKey {
  /** Byte length of an ML-KEM-768 public key. */
  static readonly SIZE_IN_BYTES = mlKem768.lengths.publicKey!;
  /** Length of the {@link PostQuantumPublicKey.toFields} encoding: one field per 31-byte chunk of the key. */
  static readonly SIZE_IN_FIELDS = Math.ceil(PostQuantumPublicKey.SIZE_IN_BYTES / (Fr.SIZE_IN_BYTES - 1));

  private constructor(private readonly key: Buffer) {}

  /**
   * Wraps the raw bytes of an ML-KEM-768 public key.
   *
   * @throws If `buffer` is not {@link PostQuantumPublicKey.SIZE_IN_BYTES} bytes long.
   */
  static fromBuffer(buffer: Buffer): PostQuantumPublicKey {
    if (buffer.length !== PostQuantumPublicKey.SIZE_IN_BYTES) {
      throw new Error(
        `A post-quantum public key is ${PostQuantumPublicKey.SIZE_IN_BYTES} bytes long, got ${buffer.length} bytes`,
      );
    }
    return new PostQuantumPublicKey(Buffer.from(buffer));
  }

  /**
   * Decodes a key from its {@link PostQuantumPublicKey.toFields} encoding.
   *
   * @throws If `fields` is not the {@link PostQuantumPublicKey.toFields} encoding of a key.
   */
  static fromFields(fields: Fr[]): PostQuantumPublicKey {
    return PostQuantumPublicKey.fromBuffer(
      bufferFromExactFieldChunks(fields, PostQuantumPublicKey.SIZE_IN_BYTES, 'post-quantum public key'),
    );
  }

  toBuffer(): Buffer {
    return Buffer.from(this.key);
  }

  /**
   * Encodes the key as {@link PostQuantumPublicKey.SIZE_IN_FIELDS} fields, the layout aztec-nr's `PostQuantumPublicKey`
   * holds.
   */
  toFields(): Fr[] {
    return bufferToFieldChunks(this.key);
  }
}
