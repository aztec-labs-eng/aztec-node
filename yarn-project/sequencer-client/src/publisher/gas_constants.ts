import { BLOBS_PER_CHECKPOINT } from '@aztec-labs/constants';
import type { SendCostRequirement } from '@aztec-labs/ethereum/l1-tx-utils';

/**
 * Worst-case gas limit of a checkpoint proposal tx in an epoch that is already set up on L1, used to check that a
 * publisher can afford it before building. On testnet v6 (Sepolia after Glamsterdam) the most expensive plain `propose`
 * used 520k gas and was sent with a 669k gas limit, which adds the 64/63 call-forwarding factor, the gas limit buffer
 * (20% by default) and the blob evaluation gas for its single blob. Each further blob adds 48 bytes of calldata and one
 * hash check (under 10k gas each), so a 6-blob checkpoint needs about 720k, rounded up with margin to 750k.
 */
export const PROPOSE_GAS = 750_000n;

/**
 * Worst-case gas limit of the first checkpoint proposal tx of an epoch, whose `propose` also runs `setupEpoch` (samples
 * the committee and stores its commitment). On testnet v6 (Sepolia after Glamsterdam) the most expensive one used 1.34M
 * gas and was sent with a 1.67M gas limit for a single blob. Sized the same way as {@link PROPOSE_GAS}: about 1.72M for
 * 6 blobs, rounded up to 1.75M.
 */
export const PROPOSE_WITH_SETUP_EPOCH_GAS = 1_750_000n;

/**
 * Worst-case gas of invalidating a checkpoint (`invalidateBadAttestation` or `invalidateInsufficientAttestations`),
 * which is bundled ahead of the proposal when the pending chain is invalid. Dominated by recomputing the committee
 * commitment and recovering the attestation signatures, so it grows with the committee size.
 */
export const INVALIDATE_GAS = 1_000_000n;

/**
 * Affordability requirement of a checkpoint proposal, optionally bundled with an invalidation of the pending chain.
 * @param opts.withSetupEpoch - Whether the proposal is the first of an epoch not yet set up on L1, so it runs setupEpoch.
 */
export function getProposeRequirement(opts: { withInvalidate: boolean; withSetupEpoch: boolean }): SendCostRequirement {
  return {
    gasLimit:
      (opts.withSetupEpoch ? PROPOSE_WITH_SETUP_EPOCH_GAS : PROPOSE_GAS) + (opts.withInvalidate ? INVALIDATE_GAS : 0n),
    blobCount: BLOBS_PER_CHECKPOINT,
  };
}

/** Affordability requirement of a standalone checkpoint invalidation. */
export const INVALIDATE_REQUIREMENT: SendCostRequirement = { gasLimit: INVALIDATE_GAS, blobCount: 0 };
