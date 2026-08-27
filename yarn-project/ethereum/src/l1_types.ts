import type { Buffer32 } from '@aztec-labs/foundation/buffer';

export type L1BlockId = {
  l1BlockNumber: bigint;
  l1BlockHash: Buffer32;
};
