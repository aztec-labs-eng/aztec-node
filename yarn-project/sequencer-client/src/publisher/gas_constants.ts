import { BLOBS_PER_CHECKPOINT } from '@aztec-labs/constants';
import type { SendCostRequirement } from '@aztec-labs/ethereum/l1-tx-utils';

/**
 * Worst-case gas limit of a checkpoint proposal tx in an epoch that is already set up on L1, used to check that a
 * publisher can afford it before building. A plain `propose` uses at most ~550k gas (testnet v6 p50 on Sepolia after
 * Glamsterdam: 487k). The send sets the gas limit to the simulated gas plus the 64/63 call-forwarding factor and the
 * gas limit buffer (20% by default), plus the blob evaluation gas: an estimate of `validateBlobs`, measured on anvil
 * at 63.6k for one blob including the buffer, with each further blob adding 48 bytes of calldata and one hash check
 * (under 10k gas each), so at most ~130k for 6 blobs:
 *
 *   ceil(550k * 64 / 63) = 558,731; * 1.2 = 670,477; + 130k blob evaluation = 800,477; rounded up with margin to 900k.
 */
export const PROPOSE_GAS = 900_000n;

/**
 * Worst-case gas limit of the first checkpoint proposal tx of an epoch, whose `propose` also runs `setupEpoch` (samples
 * the committee and stores its commitment). Measured on testnet v6 (p50, Sepolia after Glamsterdam) at 1.33M gas, and
 * sized the same way as {@link PROPOSE_GAS}:
 *
 *   ceil(1.33M * 64 / 63) = 1,351,112; * 1.2 = 1,621,334; + 130k blob evaluation = 1,751,334; rounded up to 2M.
 */
export const PROPOSE_WITH_SETUP_EPOCH_GAS = 2_000_000n;

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
