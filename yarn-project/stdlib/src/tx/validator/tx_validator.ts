import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { z } from 'zod';

import type { GasFees } from '../../gas/gas_fees.js';
import type { AllowedElement } from '../../interfaces/allowed_element.js';
import { zodFor } from '../../schemas/schemas.js';
import type { UInt64 } from '../../types/shared.js';
import type { ProcessedTx } from '../processed_tx.js';
import type { Tx } from '../tx.js';
import type { TxHash } from '../tx_hash.js';

export type AnyTx = Tx | ProcessedTx;

export function getTxHash(tx: AnyTx): TxHash {
  return 'txHash' in tx ? tx.txHash : tx.hash;
}

export function hasPublicCalls(tx: AnyTx): boolean {
  return tx.data.numberOfPublicCallRequests() > 0;
}

export type TxValidationResult = { result: 'valid' } | { result: 'invalid'; reason: string[] };

export interface TxValidator<T = AnyTx> {
  validateTx(tx: T): Promise<TxValidationResult>;
}

/**
 * What a node knows about the chain and its own policy when it validates a tx submitted over RPC, beyond the state
 * the tx is validated against.
 */
export type RpcTxValidationOptions = {
  l1ChainId: number;
  rollupVersion: number;
  /** Setup-phase functions the tx may call. */
  setupAllowList: AllowedElement[];
  /** Minimum fees the tx must cover, unless `skipFeeEnforcement` is set. */
  gasFees: GasFees;
  skipFeeEnforcement?: boolean;
  /** Set when validating for simulation: the proof is not checked and the gas ceiling is not enforced. */
  isSimulation?: boolean;
  /** Timestamp the tx's expiry is checked against. */
  timestamp: UInt64;
  /** Block the tx would be included in. */
  blockNumber: BlockNumber;
  /** Whether this node accepts txs at all. */
  txsPermitted: boolean;
  maxTxL2Gas?: number;
  maxTxDAGas?: number;
};

export const TxValidationResultSchema = zodFor<TxValidationResult>()(
  z.discriminatedUnion('result', [
    z.object({ result: z.literal('valid') }),
    z.object({ result: z.literal('invalid'), reason: z.array(z.string()) }),
  ]),
);
