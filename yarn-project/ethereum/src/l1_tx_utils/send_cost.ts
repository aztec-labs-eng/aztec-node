import { GAS_PER_BLOB } from './constants.js';
import type { FeesPerGas } from './types.js';

/** Gas limit and blob count of an L1 send, used to bound the ETH a sender must hold to submit it. */
export type SendCostRequirement = {
  /** Gas limit the tx will be sent with. */
  gasLimit: bigint;
  /** Number of blobs attached to the tx. */
  blobCount: number;
};

/**
 * Upper bound on the ETH a send needs up front: `gasLimit * maxFeePerGas + blobCount * GAS_PER_BLOB * maxFeePerBlobGas`.
 * This is what the node checks against the sender balance before accepting the tx, so a sender holding less than this
 * gets the tx rejected with an insufficient funds error.
 */
export function computeSendCost(fees: FeesPerGas, req: SendCostRequirement): bigint {
  const executionCost = req.gasLimit * fees.maxFeePerGas;
  const blobCost = BigInt(req.blobCount) * GAS_PER_BLOB * (fees.maxFeePerBlobGas ?? 0n);
  return executionCost + blobCost;
}
