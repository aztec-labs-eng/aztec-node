import type { UInt64 } from '@aztec-labs/stdlib/types';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by a {@link} doc tag
import type { roundDownTxExpirationTimestamp } from '../private_kernel/hints/round_down_tx_expiration_timestamp.js';

/** How many note hashes, nullifiers and private logs a set of side effects contains. */
export type SideEffectCounts = {
  noteHashes: number;
  nullifiers: number;
  privateLogs: number;
};

/**
 * The side effect counts of a tx. A tx with public calls publishes its side effects in two phases: non-revertible ones
 * persist even if public execution reverts, while revertible ones are discarded with it.
 */
export type TxSideEffectCounts =
  | ({ isPrivateOnlyTx: true } & SideEffectCounts)
  | { isPrivateOnlyTx: false; nonRevertible: SideEffectCounts; revertible: SideEffectCounts };

/**
 * What PXE asks a {@link ResolveExpirationAndPadding} hook to decide for a tx whose private execution is complete: the
 * bounds within which the hook picks the tx's expiration timestamp and side effect counts.
 */
export type ExpirationAndPaddingRequest = {
  anchorBlockTimestamp: UInt64;
  /**
   * The latest timestamp at which the tx can be included: the minimum over the expiry requested by each private call
   * and the upgrade horizon of each contract the tx calls privately, capped at `MAX_TX_LIFETIME` after the anchor block.
   */
  maxExpirationTimestamp: UInt64;
  /** Minimum counts of side effects that will be publicly visible: the ones the transaction creates. */
  minSideEffects: TxSideEffectCounts;
};

/** What a tx publishes: its expiry, and the counts its side effects are padded up to. */
export type ExpirationAndPadding = {
  /** At most the request's `maxExpirationTimestamp`, and later than its `anchorBlockTimestamp`. */
  expirationTimestamp: UInt64;
  /**
   * Same shape as the request's `minSideEffects`. Each count is at least the request's, and the counts of each kind add up
   * to at most the per-tx maximum (e.g. `MAX_NOTE_HASHES_PER_TX`).
   */
  sideEffects: TxSideEffectCounts;
};

/**
 * Hook choosing the expiration timestamp a tx publishes and how many side effects it pads, letting the wallet place the
 * tx in a larger privacy set.
 *
 * Reducing the expiration timestamp is free, though it shrinks the window for transaction inclusion in the blockchain.
 * Side-effect padding is performed by PXE using random values, indistinguishable from real ones, though DA transaction
 * costs are paid for them just the same.
 *
 * It runs both when simulating and when proving a tx, so that the gas a simulation measures includes the padding. When
 * absent, PXE publishes the expiry {@link roundDownTxExpirationTimestamp} returns and does not pad.
 */
export type ResolveExpirationAndPadding = (request: ExpirationAndPaddingRequest) => Promise<ExpirationAndPadding>;
