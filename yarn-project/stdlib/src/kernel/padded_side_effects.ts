import { MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX, MAX_PRIVATE_LOGS_PER_TX } from '@aztec-labs/constants';
import { makeTuple } from '@aztec-labs/foundation/array';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { BufferReader, type Tuple, serializeToBuffer } from '@aztec-labs/foundation/serialize';

import { PrivateLog } from '../logs/index.js';

export class PaddedSideEffects {
  constructor(
    public noteHashes: Tuple<Fr, typeof MAX_NOTE_HASHES_PER_TX>,
    public nullifiers: Tuple<Fr, typeof MAX_NULLIFIERS_PER_TX>,
    public privateLogs: Tuple<PrivateLog, typeof MAX_PRIVATE_LOGS_PER_TX>,
  ) {}

  toBuffer() {
    return serializeToBuffer(this.noteHashes, this.nullifiers, this.privateLogs);
  }

  static fromBuffer(buffer: Buffer | BufferReader) {
    const reader = BufferReader.asReader(buffer);
    return new PaddedSideEffects(
      reader.readArray(MAX_NOTE_HASHES_PER_TX, Fr),
      reader.readArray(MAX_NULLIFIERS_PER_TX, Fr),
      reader.readArray(MAX_PRIVATE_LOGS_PER_TX, PrivateLog),
    );
  }

  static empty() {
    return new PaddedSideEffects(
      makeTuple(MAX_NOTE_HASHES_PER_TX, Fr.zero),
      makeTuple(MAX_NULLIFIERS_PER_TX, Fr.zero),
      makeTuple(MAX_PRIVATE_LOGS_PER_TX, PrivateLog.empty),
    );
  }
}

/**
 * How many padding items the final kernel appends to each side effect array, per phase. Despite the name, which mirrors
 * the struct in the kernel circuits, these are not the lengths the arrays are padded up to: a tx with 3 revertible note
 * hashes padded up to 8 has `revertibleNoteHashes` of 5 in `PaddedSideEffectAmounts`.
 */
export class PaddedSideEffectAmounts {
  constructor(
    public nonRevertibleNoteHashes: number,
    public revertibleNoteHashes: number,
    public nonRevertibleNullifiers: number,
    public revertibleNullifiers: number,
    public nonRevertiblePrivateLogs: number,
    public revertiblePrivateLogs: number,
  ) {}

  toBuffer() {
    return serializeToBuffer(
      this.nonRevertibleNoteHashes,
      this.revertibleNoteHashes,
      this.nonRevertibleNullifiers,
      this.revertibleNullifiers,
      this.nonRevertiblePrivateLogs,
      this.revertiblePrivateLogs,
    );
  }

  static fromBuffer(buffer: Buffer | BufferReader) {
    const reader = BufferReader.asReader(buffer);
    return new PaddedSideEffectAmounts(
      reader.readNumber(),
      reader.readNumber(),
      reader.readNumber(),
      reader.readNumber(),
      reader.readNumber(),
      reader.readNumber(),
    );
  }

  static empty() {
    return new PaddedSideEffectAmounts(0, 0, 0, 0, 0, 0);
  }
}
