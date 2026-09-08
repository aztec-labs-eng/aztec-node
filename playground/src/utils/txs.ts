import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { TxHash, type TxReceipt, TxStatus } from '@aztec-labs/aztec.js/tx';

export type UserTx = {
  txHash?: TxHash;
  receipt?: TxReceipt;
  date?: number;
  status: 'error' | 'simulating' | 'proving' | 'sending' | 'success' | TxStatus;
  name: string;
  error?: string;
  contractAddress: AztecAddress;
};

export async function queryTxReceipt(tx: UserTx, node: AztecNode) {
  const txHash = await tx.txHash;
  const txReceipt = await node.getTxReceipt(txHash);
  return txReceipt;
}
