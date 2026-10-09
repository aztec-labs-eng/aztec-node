import { Blob } from '@aztec-labs/blob-lib';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Hex, type PrepareTransactionRequestRequest, createPublicClient, custom, fromRlp } from 'viem';
import { sepolia } from 'viem/chains';

import { parseSignedTransaction } from '../blob_tx.js';
import type { ViemClient } from '../types.js';
import { L1TxUtils } from './l1_tx_utils.js';

class TestL1TxUtils extends L1TxUtils {
  public override prepareSignedTransaction(txData: PrepareTransactionRequestRequest) {
    return super.prepareSignedTransaction(txData);
  }
}

describe('L1TxUtils blob wrapper', () => {
  it('signs blob txs on sepolia in the EIP-7594 network wrapper', async () => {
    const client = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: ({ method }) => Promise.reject(new Error(`Unexpected RPC request ${method}`)),
      }),
    }) as unknown as ViemClient;
    const signature = {
      r: '0x1111111111111111111111111111111111111111111111111111111111111111',
      s: '0x2222222222222222222222222222222222222222222222222222222222222222',
      yParity: 1,
    } as const;
    const utils = new TestL1TxUtils(client, EthAddress.random(), () => Promise.resolve(signature));

    const serialized = await utils.prepareSignedTransaction({
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
      nonce: 7,
      gas: 100_000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      blobs: [new Uint8Array(131072).fill(1)],
      kzg: Blob.getViemKzgInstance(),
      maxFeePerBlobGas: 3n,
    });

    const [, wrapperVersion, blobs, , cellProofs] = fromRlp(`0x${serialized.slice(4)}`, 'hex') as [
      Hex[],
      Hex,
      Hex[],
      Hex[],
      Hex[],
    ];
    expect(wrapperVersion).toEqual('0x01');
    expect(blobs).toHaveLength(1);
    expect(cellProofs).toHaveLength(128);
    expect(parseSignedTransaction(serialized)).toMatchObject({ type: 'eip4844', chainId: sepolia.id, nonce: 7 });
  });
});
