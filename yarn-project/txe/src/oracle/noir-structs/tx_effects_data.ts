import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { TxHash } from '@aztec-labs/stdlib/tx';

type TxPrivateLog = Fr[];

export type TxEffectsData = {
  txHash: TxHash;
  noteHashes: Fr[];
  nullifiers: Fr[];
  privateLogs: TxPrivateLog[];
};
