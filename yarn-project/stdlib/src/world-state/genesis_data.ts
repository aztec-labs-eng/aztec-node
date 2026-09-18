import type { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { PublicDataTreeLeaf } from '../trees/index.js';

/** Data used to initialize the genesis block, including prefilled public state and an optional timestamp. */
export type GenesisData = {
  /** Public data tree leaves to pre-populate in the genesis state (e.g. fee juice balances). */
  prefilledPublicData: PublicDataTreeLeaf[];
  /**
   * Nullifiers to pre-insert into the genesis nullifier tree. Must be unique and strictly increasing in field value
   * (the native world state enforces this before construction). Production callers pass `DEFAULT_GENESIS_DATA` from
   * `@aztec-labs/protocol-contracts`, whose list is the canonical protocol contract registration nullifiers that the
   * `GENESIS_ARCHIVE_ROOT` and `GENESIS_BLOCK_HEADER_HASH` constants are derived from; this cannot be defaulted here
   * because `@aztec-labs/stdlib` does not depend on `@aztec-labs/protocol-contracts`. Test networks add e.g. the
   * standard-contract registration nullifiers on top. Pass an explicit empty array only for low-level tree tests that
   * want a truly empty nullifier tree.
   */
  prefilledNullifiers: Fr[];
  /** Timestamp for the genesis block header. Defaults to 0 (canonical empty genesis) in production. */
  genesisTimestamp: bigint;
};

/**
 * An empty genesis data with no prefilled state and a zero timestamp. Its nullifier tree is empty, so the resulting
 * genesis roots do NOT match the canonical production roots; use `DEFAULT_GENESIS_DATA` from
 * `@aztec-labs/protocol-contracts` for anything that has to agree with a deployed rollup.
 */
export const EMPTY_GENESIS_DATA: GenesisData = {
  prefilledPublicData: [],
  prefilledNullifiers: [],
  genesisTimestamp: 0n,
};

/** Returns if an object looks like genesis data */
export function isGenesisData(obj: any): obj is GenesisData {
  return (
    obj &&
    typeof obj === 'object' &&
    'prefilledPublicData' in obj &&
    Array.isArray(obj.prefilledPublicData) &&
    'prefilledNullifiers' in obj &&
    Array.isArray(obj.prefilledNullifiers) &&
    'genesisTimestamp' in obj &&
    typeof obj.genesisTimestamp === 'bigint'
  );
}
