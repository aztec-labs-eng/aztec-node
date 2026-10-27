import type { SendCostRequirement } from '@aztec-labs/ethereum/l1-tx-utils';
import type { ReferenceSend } from '@aztec-labs/ethereum/publisher-manager';

/**
 * Worst-case gas limit of an epoch proof submission, used to check that a publisher can afford sending a finished proof.
 * Measured on testnet v6 (Sepolia after Glamsterdam): the first `submitEpochRootProof` of an epoch used at most 2.51M
 * gas, sent with a 3.06M gas limit after the gas limit buffer (20% by default). Proofs sent through a forwarder contract
 * use about 2.89M gas, so roughly 3.5M once the buffer is added.
 */
export const SUBMIT_EPOCH_PROOF_GAS = 3_500_000n;

/** Affordability requirement of an epoch proof submission, which carries no blobs. */
export const SUBMIT_EPOCH_PROOF_REQUIREMENT: SendCostRequirement = { gasLimit: SUBMIT_EPOCH_PROOF_GAS, blobCount: 0 };

/** Send the periodic publisher balance check prices to report whether a prover can afford to submit an epoch proof. */
export const SUBMIT_EPOCH_PROOF_REFERENCE_SEND: ReferenceSend = {
  name: 'epoch proof',
  requirement: SUBMIT_EPOCH_PROOF_REQUIREMENT,
};
