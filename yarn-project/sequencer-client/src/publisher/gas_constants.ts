import { BLOBS_PER_CHECKPOINT } from '@aztec-labs/constants';
import type { SendCostRequirement } from '@aztec-labs/ethereum/l1-tx-utils';

/**
 * Worst-case gas limit of a checkpoint proposal tx, used to check that a publisher can afford it before building. Must
 * cover the first checkpoint of an epoch, whose `propose` also runs `setupEpoch`. Measured on testnet v6 (p50, Sepolia
 * after Glamsterdam): plain `propose` used 487k gas and `propose` with `setupEpoch` 1.33M. The tx gas limit adds the
 * 64/63 call-forwarding factor, the configured gas limit buffer (20% by default) and the blob evaluation gas on top.
 */
export const PROPOSE_GAS = 2_500_000n;

/**
 * Worst-case gas of invalidating a checkpoint (`invalidateBadAttestation` or `invalidateInsufficientAttestations`),
 * which is bundled ahead of the proposal when the pending chain is invalid. Dominated by recomputing the committee
 * commitment and recovering the attestation signatures, so it grows with the committee size.
 */
export const INVALIDATE_GAS = 1_000_000n;

/** Affordability requirement of a checkpoint proposal, optionally bundled with an invalidation of the pending chain. */
export function getProposeRequirement(opts: { withInvalidate: boolean }): SendCostRequirement {
  return {
    gasLimit: PROPOSE_GAS + (opts.withInvalidate ? INVALIDATE_GAS : 0n),
    blobCount: BLOBS_PER_CHECKPOINT,
  };
}

/** Affordability requirement of a standalone checkpoint invalidation. */
export const INVALIDATE_REQUIREMENT: SendCostRequirement = { gasLimit: INVALIDATE_GAS, blobCount: 0 };
