import { z } from 'zod';

import { zodFor } from '../../schemas/schemas.js';
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

/**
 * Outcome of validating a tx. `invalid` is a verdict on the tx. `unverifiable` means a check could not run (for example,
 * the proof verifier was unavailable), so it is no verdict at all: callers must neither accept the tx nor hold it against
 * the tx or whoever sent it.
 */
export type TxValidationResult =
  | { result: 'valid' }
  | { result: 'invalid'; reason: string[] }
  | { result: 'unverifiable'; reason: string[] };

export interface TxValidator<T = AnyTx> {
  validateTx(tx: T): Promise<TxValidationResult>;
}

export const TxValidationResultSchema = zodFor<TxValidationResult>()(
  z.discriminatedUnion('result', [
    z.object({ result: z.literal('valid') }),
    z.object({ result: z.literal('invalid'), reason: z.array(z.string()) }),
    z.object({ result: z.literal('unverifiable'), reason: z.array(z.string()) }),
  ]),
);
