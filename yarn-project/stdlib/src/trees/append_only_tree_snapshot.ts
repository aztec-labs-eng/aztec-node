import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { schemas } from '@aztec-labs/foundation/schemas';
import { BufferReader, BufferSink, FieldReader } from '@aztec-labs/foundation/serialize';
import { bufferToHex, hexToBuffer } from '@aztec-labs/foundation/string';
import { inspect } from 'util';
import { z } from 'zod';

import { TreeLeafIndex, TreeLeafIndexSchema } from './tree_leaf_index.js';

/**
 * Snapshot of an append only tree.
 *
 * Used in circuits to verify that tree insertions are performed correctly.
 */
export class AppendOnlyTreeSnapshot {
  constructor(
    /**
     * Root of the append only tree when taking the snapshot.
     */
    public root: Fr,
    /**
     * Index of the next available leaf in the append only tree.
     *
     * Note: We include the next available leaf index in the snapshot so that the snapshot can be used to verify that
     *       the insertion was performed at the correct place. If we only verified tree root then it could happen that
     *       some leaves would get overwritten and the tree root check would still pass.
     *       TLDR: We need to store the next available leaf index to ensure that the "append only" property was
     *             preserved when verifying state transitions.
     */
    public nextAvailableLeafIndex: TreeLeafIndex,
  ) {
    TreeLeafIndex(nextAvailableLeafIndex);
  }

  static get schema() {
    return z
      .object({
        root: schemas.Fr,
        nextAvailableLeafIndex: TreeLeafIndexSchema,
      })
      .transform(({ root, nextAvailableLeafIndex }) => new AppendOnlyTreeSnapshot(root, nextAvailableLeafIndex));
  }

  getSize() {
    return this.root.size + 8;
  }

  toBuffer(): Buffer;
  toBuffer(sink: BufferSink): void;
  toBuffer(sink?: BufferSink): Buffer | void {
    if (!sink) {
      return BufferSink.serialize(this);
    }
    this.root.toBuffer(sink);
    sink.writeUInt64(BigInt(this.nextAvailableLeafIndex));
  }

  toFields(): Fr[] {
    return [this.root, new Fr(this.nextAvailableLeafIndex)];
  }

  toString(): string {
    return bufferToHex(this.toBuffer());
  }

  static fromBuffer(buffer: Buffer | BufferReader): AppendOnlyTreeSnapshot {
    const reader = BufferReader.asReader(buffer);
    return new AppendOnlyTreeSnapshot(Fr.fromBuffer(reader), TreeLeafIndex.fromBigInt(reader.readUInt64()));
  }

  static fromString(str: string): AppendOnlyTreeSnapshot {
    return AppendOnlyTreeSnapshot.fromBuffer(hexToBuffer(str));
  }

  static fromFields(fields: Fr[] | FieldReader): AppendOnlyTreeSnapshot {
    const reader = FieldReader.asReader(fields);

    return new AppendOnlyTreeSnapshot(reader.readField(), TreeLeafIndex.fromField(reader.readField()));
  }

  toAbi(): [`0x${string}`, number] {
    return [this.root.toString(), this.nextAvailableLeafIndex];
  }

  static empty() {
    return new AppendOnlyTreeSnapshot(Fr.ZERO, 0);
  }

  /**
   * Creates an AppendOnlyTreeSnapshot instance from a plain object without Zod parsing.
   * This method is optimized for performance and skips coercion, making it suitable
   * for deserializing trusted data (e.g., from C++ via MessagePack), which hands over a uint64 leaf index as a
   * bigint. The leaf index is still range-checked, since a value outside the safe integer range cannot be
   * represented.
   * @param obj - Plain object containing AppendOnlyTreeSnapshot fields
   * @returns An AppendOnlyTreeSnapshot instance
   */
  static fromPlainObject(obj: any): AppendOnlyTreeSnapshot {
    return new AppendOnlyTreeSnapshot(Fr.fromPlainObject(obj.root), TreeLeafIndex.coerce(obj.nextAvailableLeafIndex));
  }

  isEmpty(): boolean {
    return this.root.isZero() && this.nextAvailableLeafIndex === 0;
  }

  [inspect.custom]() {
    return `AppendOnlyTreeSnapshot { root: ${this.root.toString()}, nextAvailableLeafIndex: ${
      this.nextAvailableLeafIndex
    } }`;
  }

  public equals(other: this) {
    return this.root.equals(other.root) && this.nextAvailableLeafIndex === other.nextAvailableLeafIndex;
  }

  static random() {
    return new AppendOnlyTreeSnapshot(Fr.random(), Math.floor(Math.random() * 1000));
  }
}
