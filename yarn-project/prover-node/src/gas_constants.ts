import type { SendCostRequirement } from '@aztec-labs/ethereum/l1-tx-utils';

/**
 * Worst-case gas limit of an epoch proof submission, used to check that a publisher can afford it before proving.
 * Measured on testnet v6 (p50, Sepolia after Glamsterdam): the first `submitEpochRootProof` of an epoch used 2.36M gas
 * and later ones 1.55M. The tx gas limit adds the configured gas limit buffer (20% by default) on top of the estimate.
 */
export const SUBMIT_EPOCH_PROOF_GAS = 3_500_000n;

/** Affordability requirement of an epoch proof submission, which carries no blobs. */
export const SUBMIT_EPOCH_PROOF_REQUIREMENT: SendCostRequirement = { gasLimit: SUBMIT_EPOCH_PROOF_GAS, blobCount: 0 };
