import type { EthCheatCodes } from '@aztec-labs/ethereum/test';
import type { Logger } from '@aztec-labs/foundation/log';
import type { Hex } from 'viem';

/**
 * Mines the L1 block for a tx that was just sent while anvil mining is paused. If `evm_mine` fails, or the block it
 * mines leaves the tx out (say, a burst of queued txs filled the block), automine is turned back on so that anvil mines
 * the pool. Without that nothing would ever mine the tx: the tx monitor measures its timeouts against L1 block
 * timestamps, which do not move while mining is paused, so it would wait forever and the pause would never end.
 * Rethrows an `evm_mine` error once automine is back on.
 */
export async function mineSentTx(
  ethCheatCodes: Pick<EthCheatCodes, 'evmMine' | 'setAutomine' | 'publicClient'>,
  txHash: Hex,
  log: Logger,
): Promise<void> {
  try {
    await ethCheatCodes.evmMine({ silent: true });
  } catch (err) {
    await ethCheatCodes.setAutomine(true, { silent: true });
    throw err;
  }

  const mined = await ethCheatCodes.publicClient.getTransactionReceipt({ hash: txHash }).then(
    () => true,
    () => false,
  );
  if (!mined) {
    log.warn(`L1 tx ${txHash} was left out of the block mined for it, re-enabling automine to mine it`, { txHash });
    await ethCheatCodes.setAutomine(true, { silent: true });
  }
}
