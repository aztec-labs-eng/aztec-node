import { FeeJuiceArtifact } from '@aztec-labs/protocol-contracts/fee-juice';
import { getCallRequestsWithCalldataByPhase } from '@aztec-labs/simulator/server';
import { FunctionSelector, getAllFunctionAbis } from '@aztec-labs/stdlib/abi';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type Tx, TxExecutionPhase } from '@aztec-labs/stdlib/tx';

export type FeePayerBalanceDelta = {
  feeLimit: bigint;
  claimAmount: bigint;
};

const increasePublicBalanceSelectorPromise = (() => {
  const fn = getAllFunctionAbis(FeeJuiceArtifact).find(f => f.name === '_increase_public_balance')!;
  return FunctionSelector.fromNameAndParameters(fn.name, fn.parameters);
})();

export function getTxFeeLimit(tx: Tx): bigint {
  return tx.data.constants.txContext.gasSettings.getFeeLimit().toBigInt();
}

export async function getFeePayerClaimAmount(tx: Tx, feeJuiceAddress: AztecAddress): Promise<bigint> {
  const setupFns = getCallRequestsWithCalldataByPhase(tx, TxExecutionPhase.SETUP);
  const increasePublicBalanceSelector = await increasePublicBalanceSelectorPromise;
  const feePayer = tx.data.feePayer;

  const claimFunctionCall = setupFns.find(
    fn =>
      fn.request.contractAddress.equals(feeJuiceAddress) &&
      fn.request.msgSender.equals(feeJuiceAddress) &&
      fn.calldata.length > 2 &&
      fn.functionSelector.equals(increasePublicBalanceSelector) &&
      fn.args[0].equals(feePayer.toField()) &&
      !fn.request.isStaticCall,
  );

  return claimFunctionCall ? claimFunctionCall.args[1].toBigInt() : 0n;
}

export async function getFeePayerBalanceDelta(tx: Tx, feeJuiceAddress: AztecAddress): Promise<FeePayerBalanceDelta> {
  return {
    feeLimit: getTxFeeLimit(tx),
    claimAmount: await getFeePayerClaimAmount(tx, feeJuiceAddress),
  };
}
