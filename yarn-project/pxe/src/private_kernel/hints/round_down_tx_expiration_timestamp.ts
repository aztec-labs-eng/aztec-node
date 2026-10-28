import { MAX_TX_LIFETIME } from '@aztec-labs/constants';
import type { UInt64 } from '@aztec-labs/stdlib/types';

import type { ExpirationAndPaddingRequest } from '../../hooks/resolve_expiration_and_padding.js';

const ROUNDED_DURATIONS = [
  3600, // 1 hour
  1800, // 30 mins
  1, // 1 second
];

function roundTimestamp(blockTimestamp: bigint, expirationTimestamp: bigint): UInt64 {
  return ROUNDED_DURATIONS.reduce((timestamp, duration) => {
    if (timestamp <= blockTimestamp) {
      // The timestamp must be greater than the block timestamp.
      // If it is too small, round it down again using a smaller duration.
      const totalDuration = expirationTimestamp - blockTimestamp;
      const roundedDuration = totalDuration - (totalDuration % BigInt(duration));
      return blockTimestamp + roundedDuration;
    }
    return timestamp;
  }, 0n);
}

/**
 * Rounds a tx's expiration timestamp down to a coarser one, capped at `txLifetime` after the anchor block. This is the
 * expiry PXE publishes when no `resolveExpirationAndPadding` hook is set.
 */
export function roundDownTxExpirationTimestamp(
  {
    anchorBlockTimestamp,
    maxExpirationTimestamp: expirationTimestamp,
  }: Pick<ExpirationAndPaddingRequest, 'anchorBlockTimestamp' | 'maxExpirationTimestamp'>,
  txLifetime = MAX_TX_LIFETIME,
): UInt64 {
  if (txLifetime > MAX_TX_LIFETIME) {
    throw new Error(
      `Custom tx lifetime cannot be greater than the max allowed. Max allowed: ${MAX_TX_LIFETIME}. Custom value: ${txLifetime}.`,
    );
  }

  const maxTimestamp = anchorBlockTimestamp + BigInt(txLifetime);

  // If the expirationTimestamp set during the tx execution is greater than or equal to the max allowed duration,
  // use the maximum allowed timestamp.
  // Note: It shouldn't be larger than the max allowed duration, but we check for it anyway.
  if (expirationTimestamp >= maxTimestamp) {
    return maxTimestamp;
  }

  // Round it down to the nearest hour/min/second to reduce precision and avoid revealing the exact value.
  // This makes it harder for others to infer what function calls may have been used to produce a specific timestamp.
  const roundedTimestamp = roundTimestamp(anchorBlockTimestamp, expirationTimestamp);

  // An expiration at or below the anchor block's timestamp leaves the tx includable only in a block sharing the
  // anchor's timestamp (if any), so it is rejected here rather than submitted.
  if (roundedTimestamp <= anchorBlockTimestamp) {
    throw new Error(
      `Expiration timestamp must be greater than the anchor block timestamp. Anchor block timestamp: ${anchorBlockTimestamp}. Expiration timestamp: ${expirationTimestamp}.`,
    );
  }

  return roundedTimestamp;
}
