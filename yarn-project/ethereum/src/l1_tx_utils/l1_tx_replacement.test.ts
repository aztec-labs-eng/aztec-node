import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { jest } from '@jest/globals';
import { mock } from 'jest-mock-extended';
import type { Hex, TransactionReceipt } from 'viem';

import type { ViemClient } from '../types.js';
import { L1TxUtils } from './l1_tx_utils.js';
import type { L1TxRequest, SigningCallback } from './types.js';

/** Captures transaction payloads while exercising the real monitoring and replacement loop. */
class CapturingL1TxUtils extends L1TxUtils {
  public readonly signed = new Map<Hex, Parameters<ViemClient['prepareTransactionRequest']>[0]>();

  protected override prepareSignedTransaction(request: Parameters<ViemClient['prepareTransactionRequest']>[0]) {
    const hash: Hex = `0x${this.signed.size.toString(16).padStart(64, '0')}`;
    this.signed.set(hash, request);
    return Promise.resolve(hash);
  }
}

describe('L1 transaction replacement', () => {
  const original: L1TxRequest = { to: EthAddress.random().toString(), data: '0x1234' };
  const replacement: L1TxRequest = { ...original, data: '0x12345678' };
  const originalHash: Hex = `0x${'00'.repeat(32)}`;
  const replacementHash: Hex = `0x${'00'.repeat(31)}01`;

  function setup() {
    const client = mock<ViemClient>();
    let timestamp = 0n;
    let minedHash: Hex | undefined;
    client.getBlock.mockImplementation(() => Promise.resolve(mock({ timestamp: timestamp++ })));
    client.getTransactionCount.mockImplementation(() => Promise.resolve(minedHash ? 1 : 0));
    client.getTransactionReceipt.mockImplementation(({ hash }) => {
      if (hash !== minedHash) {
        return Promise.reject(Object.assign(new Error('not mined'), { name: 'TransactionReceiptNotFoundError' }));
      }
      return Promise.resolve(mock<TransactionReceipt>({ transactionHash: hash, status: 'success' }));
    });
    client.sendRawTransaction.mockImplementation(({ serializedTransaction }) => Promise.resolve(serializedTransaction));
    const utils = new CapturingL1TxUtils(
      client,
      EthAddress.random(),
      jest.fn<SigningCallback>(),
      createLogger('test:l1-replacement'),
      new DateProvider(),
      { maxSpeedUpAttempts: 0, stallTimeMs: 1000, checkIntervalMs: 1, cancelTxOnTimeout: false },
    );
    jest
      .spyOn(utils, 'estimateGas')
      .mockImplementation((_account, request) =>
        Promise.resolve(request.data === replacement.data ? 200_000n : 100_000n),
      );
    jest.spyOn(utils, 'getFeesPerGas').mockImplementation((_config, _blob, _attempt, previous) =>
      Promise.resolve({
        maxFeePerGas: previous ? (previous.maxFeePerGas * 150n) / 100n : 100n,
        maxPriorityFeePerGas: previous ? (previous.maxPriorityFeePerGas * 150n) / 100n : 10n,
      }),
    );
    return { client, utils, mine: (hash: Hex) => (minedHash = hash) };
  }

  it('replaces calldata at the same nonce after ordinary speed-ups are exhausted', async () => {
    const { client, utils, mine } = setup();
    client.sendRawTransaction.mockImplementation(({ serializedTransaction }) => {
      if (serializedTransaction === replacementHash) {
        mine(replacementHash);
      }
      return Promise.resolve(serializedTransaction);
    });

    const { receipt, state } = await utils.sendAndMonitorTransaction(
      original,
      { txTimeoutAt: new Date(20_000), txTimeoutMs: 0 },
      undefined,
      { getReplacement: () => Promise.resolve(replacement) },
    );

    expect(receipt.transactionHash).toEqual(replacementHash);
    const first = utils.signed.get(originalHash)!;
    const second = utils.signed.get(replacementHash)!;
    expect(second.nonce).toEqual(first.nonce);
    expect(second.data).toEqual(replacement.data);
    expect(second.gas).toEqual(200_000n);
    expect(second.maxPriorityFeePerGas).toBeGreaterThan(first.maxPriorityFeePerGas!);
    expect(state.request).toEqual(replacement);
    expect(state.gasLimit).toEqual(200_000n);
  });

  it.each([true, false])('reports an older mined payload (replacement rejected: %s)', async rejectReplacement => {
    const { client, utils, mine } = setup();
    client.sendRawTransaction.mockImplementation(({ serializedTransaction }) => {
      if (serializedTransaction === replacementHash) {
        mine(originalHash);
        if (rejectReplacement) {
          return Promise.reject(new Error('nonce too low'));
        }
      }
      return Promise.resolve(serializedTransaction);
    });

    const { receipt, state } = await utils.sendAndMonitorTransaction(
      original,
      { txTimeoutAt: new Date(20_000), txTimeoutMs: 0 },
      undefined,
      { getReplacement: () => Promise.resolve(replacement) },
    );

    expect(receipt.transactionHash).toEqual(originalHash);
    expect(state.request).toEqual(original);
    expect(state.gasLimit).toEqual(100_000n);
    expect(state.txHashes).toEqual(rejectReplacement ? [originalHash] : [originalHash, replacementHash]);
  });

  it('cancels at the deadline instead of broadcasting a newly prepared proof', async () => {
    const { client, utils, mine } = setup();
    const broadcast: Hex[] = [];
    client.sendRawTransaction.mockImplementation(({ serializedTransaction }) => {
      broadcast.push(serializedTransaction);
      if (serializedTransaction !== originalHash) {
        mine(serializedTransaction);
      }
      return Promise.resolve(serializedTransaction);
    });

    await expect(
      utils.sendAndMonitorTransaction(
        original,
        {
          txTimeoutAt: new Date(3_000),
          txTimeoutMs: 0,
          cancelTxOnTimeout: true,
        },
        undefined,
        { getReplacement: () => Promise.resolve(replacement) },
      ),
    ).rejects.toThrow('timed out');
    await utils.waitMonitoringStopped(1);

    expect(broadcast.map(hash => utils.signed.get(hash)!.data)).toEqual([original.data, '0x']);
    const cancellation = utils.signed.get(broadcast.at(-1)!)!;
    expect(cancellation.to).toEqual(utils.getSenderAddress().toString());
    expect(cancellation.data).toEqual('0x');
    expect(cancellation.value).toEqual(0n);
    expect(cancellation.nonce).toEqual(utils.signed.get(originalHash)!.nonce);
  });

  it('does not restart ordinary speed-ups after replacing the payload', async () => {
    const { utils } = setup();
    utils.updateConfig({ maxSpeedUpAttempts: 1 });

    await expect(
      utils.sendAndMonitorTransaction(original, { txTimeoutAt: new Date(8_000), txTimeoutMs: 0 }, undefined, {
        getReplacement: state =>
          Promise.resolve(state.txHashes.length > 1 && state.request.data === original.data ? replacement : undefined),
      }),
    ).rejects.toThrow('timed out');

    expect([...utils.signed.values()].map(({ data }) => data)).toEqual([
      original.data,
      original.data,
      replacement.data,
    ]);
  });
});
