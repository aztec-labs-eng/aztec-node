import type { GenesisData } from '@aztec-labs/stdlib/world-state';

import { ProtocolContractGenesisNullifiers } from './protocol_contract_data.js';

/**
 * Canonical genesis data for a production network. Seeds the protocol contract registration nullifiers
 * ({@link ProtocolContractGenesisNullifiers}) into the genesis nullifier tree, so that an on-chain re-publish of a
 * bundled protocol class id pushes an already-existing nullifier and the transaction is rejected as a duplicate
 * nullifier before it ever reaches the archiver. The `GENESIS_BLOCK_HEADER_HASH` and `GENESIS_ARCHIVE_ROOT` constants
 * are derived from this genesis, so production world-state callers must build on top of it rather than on
 * `EMPTY_GENESIS_DATA`, or their roots diverge from the deployed rollup.
 */
export const DEFAULT_GENESIS_DATA: GenesisData = {
  prefilledPublicData: [],
  prefilledNullifiers: ProtocolContractGenesisNullifiers,
  genesisTimestamp: 0n,
};
