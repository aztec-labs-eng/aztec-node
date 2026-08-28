import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { BlockHash } from '@aztec-labs/stdlib/block';
import type { TxHash } from '@aztec-labs/stdlib/tx';
import type { UInt64 } from '@aztec-labs/stdlib/types';

/**
 * Intermediate struct used to perform batch log retrieval by PXE. The `utilityBulkRetrieveLogs` oracle stores values of this
 * type in a `EphemeralArray`.
 */
export type LogRetrievalResponse = {
  logPayload: Fr[];
  txHash: TxHash;
  uniqueNoteHashesInTx: Fr[];
  firstNullifierInTx: Fr;
  blockNumber: BlockNumber;
  blockTimestamp: UInt64;
  blockHash: BlockHash;
};
