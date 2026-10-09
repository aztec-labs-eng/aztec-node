import { Blob } from '@aztec-labs/blob-lib';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { TransactionSerializableEIP4844, WalletClient } from 'viem';

import { serializeSignedTransaction } from '../blob_tx.js';
import { createViemSigner } from './signer.js';

describe('createViemSigner', () => {
  it('extracts the signature from a blob tx signed in the EIP-7594 network wrapper', async () => {
    const signature = {
      r: '0x1111111111111111111111111111111111111111111111111111111111111111',
      s: '0x2222222222222222222222222222222222222222222222222222222222222222',
      yParity: 1,
    } as const;
    const tx: TransactionSerializableEIP4844 = {
      type: 'eip4844',
      chainId: 11_155_111,
      nonce: 7,
      to: '0x1234567890123456789012345678901234567890',
      gas: 100_000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      maxFeePerBlobGas: 3n,
      blobs: [new Uint8Array(131072).fill(1)],
      kzg: Blob.getViemKzgInstance(),
    };
    const client = {
      signTransaction: () => Promise.resolve(serializeSignedTransaction(tx, signature)),
    } as unknown as WalletClient;

    const signer = createViemSigner(client);
    await expect(signer(tx, EthAddress.random())).resolves.toEqual(signature);
  });
});
