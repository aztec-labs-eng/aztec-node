import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Hex } from 'viem';

/**
 * Information about a matching CALL
 */
export interface CallInfo {
  from: EthAddress;
  gasUsed?: bigint;
  input: Hex;
  value: bigint;
}

/** Entries in an L1 call trace returned by the L1 RPC, which may be a third-party provider. */
export const MAX_L1_TRACE_LEN = 1_000_000;
