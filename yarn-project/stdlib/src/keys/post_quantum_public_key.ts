import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ml_kem768 as mlKem768 } from '@noble/post-quantum/ml-kem';
import { Buffer } from 'buffer';

import { bufferFromFieldChunks, bufferToFieldChunks } from '../abi/buffer.js';

/**
 * An account's post-quantum public key.
 *
 * It is an ML-KEM-768 public key, which senders encapsulate to in order to establish a post-quantum shared secret with
 * the account. Unlike their elliptic curve key, which is their address point, accounts have no native post-quantum
 * public key, so they register theirs in the post-quantum public key registry for senders to learn it.
 *
 * TypeScript counterpart of aztec-nr's `PostQuantumPublicKey`, whose fields are this key's
 * {@link PostQuantumPublicKey.toFields} encoding.
 */
export class PostQuantumPublicKey {
  /** Byte length of an ML-KEM-768 public key. */
  static readonly SIZE_IN_BYTES = mlKem768.publicKeyLen;
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
    if (fields.length !== PostQuantumPublicKey.SIZE_IN_FIELDS) {
      throw new Error(
        `A post-quantum public key is encoded in ${PostQuantumPublicKey.SIZE_IN_FIELDS} fields, got ${fields.length}`,
      );
    }
    const key = PostQuantumPublicKey.fromBuffer(
      bufferFromFieldChunks(fields).subarray(0, PostQuantumPublicKey.SIZE_IN_BYTES),
    );
    // Decoding ignores each field's top byte, and the last field's bytes past the end of the key, so a field with bits
    // set there decodes to the same key as a well-formed encoding. Re-encoding the key and comparing catches it.
    const index = key.toFields().findIndex((field, i) => !field.equals(fields[i]));
    if (index !== -1) {
      throw new Error(
        `Field ${index} of a post-quantum public key encoding holds bits outside the key: ${fields[index]}`,
      );
    }
    return key;
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
