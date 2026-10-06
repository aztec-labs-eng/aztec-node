import type { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { BlockReference } from '../../storage/fact_store/index.js';
import type { Option } from './option.js';

/** TypeScript counterpart of `NoteOrigin` in Aztec.nr. */
export type NoteOrigin = {
  /** Hash of the tx that created the note. */
  txHash: Fr;
  /** The block that tx was included in. */
  block: BlockReference;
  /**
   * The block the note's nullifier was included in. Absent when the note has not been nullified or its nullifier is
   * pending in the current transaction.
   */
  nullificationBlock: Option<BlockReference>;
};
