import { Blob } from '@aztec-labs/blob-lib';
import { randomBytes } from '@aztec-labs/foundation/crypto/random';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { jest } from '@jest/globals';
import { type Hex, type PrepareTransactionRequestRequest, createPublicClient, custom, fromRlp, toHex } from 'viem';
import { sepolia } from 'viem/chains';

import { parseSignedTransaction } from '../blob_tx.js';
import { createExtendedL1Client } from '../client.js';
import { startAnvil } from '../test/start_anvil.js';
import type { ViemClient } from '../types.js';
import { L1TxUtils } from './l1_tx_utils.js';
import { createViemSigner } from './signer.js';

const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

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

  it('tracks a blob tx sent in the EIP-7594 network wrapper by the hash the node assigns it', async () => {
    const { rpcUrl, stop } = await startAnvil({ port: 0, chainId: sepolia.id });
    try {
      const client = createExtendedL1Client([rpcUrl], ANVIL_PRIVATE_KEY, sepolia);
      const utils = new L1TxUtils(client, EthAddress.fromString(client.account.address), createViemSigner(client));

      const originalSendRawTransaction = client.sendRawTransaction.bind(client);
      const sent: { serialized: Hex; nodeHash: Hex }[] = [];
      using _spy = jest.spyOn(client, 'sendRawTransaction').mockImplementation(async args => {
        sent.push({ serialized: args.serializedTransaction, nodeHash: await originalSendRawTransaction(args) });
        return toHex(randomBytes(32));
      });

      const { txHash } = await utils.sendTransaction(
        { to: '0x1234567890123456789012345678901234567890', data: '0x', value: 0n },
        undefined,
        { blobs: [new Uint8Array(131072).fill(1)], kzg: Blob.getViemKzgInstance(), maxFeePerBlobGas: 10n ** 10n },
      );

      expect(sent).toHaveLength(1);
      expect(fromRlp(`0x${sent[0].serialized.slice(4)}`, 'hex')).toHaveLength(5);
      expect(txHash).toEqual(sent[0].nodeHash);
    } finally {
      await stop();
    }
  }, 30_000);
});
