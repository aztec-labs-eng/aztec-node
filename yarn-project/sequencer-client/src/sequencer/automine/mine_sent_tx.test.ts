import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import { type Anvil, EthCheatCodes, startAnvil } from '@aztec-labs/ethereum/test';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { createLogger } from '@aztec-labs/foundation/log';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { jest } from '@jest/globals';
import { type Hex, parseGwei } from 'viem';
import { foundry } from 'viem/chains';

import { mineSentTx } from './mine_sent_tx.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const TRANSFER_GAS = 21_000n;

describe('mineSentTx', () => {
  const log = createLogger('sequencer:test:mine-sent-tx');
  let anvil: Anvil;
  let rpcUrl: string;
  let cheatCodes: EthCheatCodes;
  let senders: ExtendedViemWalletClient[];

  beforeEach(async () => {
    ({ anvil, rpcUrl } = await startAnvil({ port: 0 }));
    cheatCodes = new EthCheatCodes([rpcUrl], new DateProvider());
    senders = [0, 1, 2, 3].map(index => createExtendedL1Client([rpcUrl], MNEMONIC, foundry, undefined, index));
    await cheatCodes.setIntervalMining(0, { silent: true });
    await cheatCodes.setAutomine(false, { silent: true });
  });

  afterEach(async () => {
    await anvil.stop();
  });

  /** Sends a plain transfer without waiting for it to be mined, as the paused build sees the propose. */
  const sendTransfer = (sender: ExtendedViemWalletClient, maxPriorityFeePerGas: bigint): Promise<Hex> =>
    sender.sendTransaction({
      to: sender.account.address,
      value: 0n,
      gas: TRANSFER_GAS,
      maxFeePerGas: parseGwei('100'),
      maxPriorityFeePerGas,
    });

  const isMined = (hash: Hex) =>
    cheatCodes.publicClient.getTransactionReceipt({ hash }).then(
      () => true,
      () => false,
    );

  it('mines the tx in one block and leaves mining paused', async () => {
    const txHash = await sendTransfer(senders[0], parseGwei('1'));

    await mineSentTx(cheatCodes, txHash, log);

    expect(await isMined(txHash)).toBe(true);
    expect(await cheatCodes.isAutoMining()).toBe(false);
  });

  it('re-enables automine to mine the tx when the block it mines leaves the tx out', async () => {
    // Room for two transfers per block: the three better-paying ones take the mined block, the tx is left in the pool.
    await cheatCodes.setBlockGasLimit(TRANSFER_GAS * 2n + 1n);
    await cheatCodes.evmMine({ silent: true });
    for (const sender of senders.slice(1)) {
      await sendTransfer(sender, parseGwei('10'));
    }
    const txHash = await sendTransfer(senders[0], parseGwei('1'));

    await mineSentTx(cheatCodes, txHash, log);

    await retryUntil(() => isMined(txHash), 'tx mined', 5, 0.1);
    expect(await cheatCodes.isAutoMining()).toBe(true);
  });

  it('re-enables automine to mine the tx and rethrows when evm_mine fails', async () => {
    const txHash = await sendTransfer(senders[0], parseGwei('1'));
    jest.spyOn(cheatCodes, 'evmMine').mockRejectedValueOnce(new Error('evm_mine failed'));

    await expect(mineSentTx(cheatCodes, txHash, log)).rejects.toThrow('evm_mine failed');

    await retryUntil(() => isMined(txHash), 'tx mined', 5, 0.1);
    expect(await cheatCodes.isAutoMining()).toBe(true);
  });
});
