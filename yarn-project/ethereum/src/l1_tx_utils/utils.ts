import { compactArray } from '@aztec-labs/foundation/collection';
import type { ContractFunctionExecutionError, TransactionReceipt } from 'viem';

export function tryGetCustomErrorNameContractFunction(err: ContractFunctionExecutionError) {
  return compactArray([err.shortMessage, ...(err.metaMessages ?? []).slice(0, 2).map(s => s.trim())]).join(' ');
}

/*
 * Returns cost of calldata usage in Ethereum.
 * @param data - Calldata.
 * @returns 4 for each zero byte, 16 for each nonzero.
 */
export function getCalldataGasUsage(data: Uint8Array) {
  return data.filter(byte => byte === 0).length * 4 + data.filter(byte => byte !== 0).length * 16;
}

/** Bounded receipt diagnostics without event payloads or the logs bloom. */
export function summarizeTransactionReceipt(receipt: TransactionReceipt) {
  return {
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    blobGasUsed: receipt.blobGasUsed,
    blobGasPrice: receipt.blobGasPrice,
    logCount: receipt.logs.length,
  };
}
