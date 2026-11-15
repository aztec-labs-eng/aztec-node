import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { times } from '@aztec-labs/foundation/collection';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryFastUntil } from '@aztec-labs/foundation/retry';
import { DateProvider } from '@aztec-labs/foundation/timer';
import type { EpochProverFactory } from '@aztec-labs/prover-client';
import type { CheckpointSubTreeOrchestrator, ChonkCache } from '@aztec-labs/prover-client/orchestrator';
import type { PublicProcessor, PublicProcessorFactory } from '@aztec-labs/simulator/server';
import { type BlockData, L2Block, type L2BlockSource } from '@aztec-labs/stdlib/block';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type {
  ForkMerkleTreeOperations,
  ITxProvider,
  WorldStateSynchronizer,
} from '@aztec-labs/stdlib/interfaces/server';
import type { InboxMessageRange, L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { type ProcessedTx, type Tx, TxHash } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

import { EarlyBlockProver } from './early-block-prover.js';

describe('EarlyBlockProver', () => {
  let l2BlockSource: MockProxy<L2BlockSource>;
  let proverFactory: MockProxy<EpochProverFactory>;
  let txProvider: MockProxy<ITxProvider>;
  let chonkCache: MockProxy<ChonkCache>;
  let publicProcessorFactory: MockProxy<PublicProcessorFactory>;
  let prover: EarlyBlockProver;

  /** Blocks the archiver holds, by number. Block 0 is the genesis block, in slot 0. */
  let chain: Map<number, L2Block>;
  /** The archiver's checkpointed tip. */
  let checkpointedBlock: number;
  /** One blocks-only sub-tree per slot that early proving started for, in creation order. */
  let subTrees: MockProxy<CheckpointSubTreeOrchestrator>[];

  beforeEach(async () => {
    l2BlockSource = mock<L2BlockSource>();
    proverFactory = mock<EpochProverFactory>();
    txProvider = mock<ITxProvider>();
    chonkCache = mock<ChonkCache>();
    const l1ToL2MessageSource = mock<L1ToL2MessageSource>();
    const worldState = mock<WorldStateSynchronizer>();
    publicProcessorFactory = mock<PublicProcessorFactory>();
    const dbProvider = mock<Pick<ForkMerkleTreeOperations, 'fork'>>();

    chain = new Map([[0, await makeBlock(0, 0)]]);
    checkpointedBlock = 0;
    subTrees = [];

    l2BlockSource.getL1Constants.mockResolvedValue({ ...EmptyL1RollupConstants, epochDuration: 4 });
    l2BlockSource.getBlockNumber.mockImplementation(() => Promise.resolve(BlockNumber(checkpointedBlock)));
    l2BlockSource.getBlocks.mockImplementation(query => {
      const { from, limit } = query as { from: BlockNumber; limit: number };
      return Promise.resolve([...chain.values()].filter(block => block.number >= from && block.number < from + limit));
    });
    l2BlockSource.getBlockData.mockImplementation(query => {
      const block = 'number' in query ? chain.get(Number(query.number)) : undefined;
      // A plain object: a mock would wrap the header, and the prover reads its real slot and block number.
      return Promise.resolve(block && ({ header: block.header } as BlockData));
    });
    l1ToL2MessageSource.getL1ToL2MessageRange.mockResolvedValue(mock<InboxMessageRange>({ messages: [] }));
    txProvider.getTxsForBlock.mockResolvedValue({ txs: [], missingTxs: [] });
    dbProvider.fork.mockResolvedValue(mock<MerkleTreeWriteOperations>());
    publicProcessorFactory.create.mockReturnValue(
      mock<PublicProcessor>({ process: () => Promise.resolve([[], [], [], [], []]) as never }),
    );
    proverFactory.createBlocksOnlySubTreeOrchestrator.mockImplementation(() => {
      const subTree = mock<CheckpointSubTreeOrchestrator>();
      subTree.whenBlockRootProven.mockReturnValue(new Promise(() => {}));
      subTrees.push(subTree);
      return Promise.resolve(subTree);
    });

    prover = new EarlyBlockProver({
      l2BlockSource,
      l1ToL2MessageSource,
      worldState,
      proverFactory,
      chonkCache,
      publicProcessorFactory,
      dbProvider,
      txProvider,
      dateProvider: new DateProvider(),
      proverId: EthAddress.ZERO,
      txGatheringTimeoutMs: 30_000,
      deadline: undefined,
    });
  });

  afterEach(async () => {
    await prover.stop();
  });

  it('starts proving a block when it is proposed', async () => {
    const block = await propose(1, 5);

    prover.onChainProposed(BlockNumber(1));
    await provenBlocks(subTrees, 0, [1]);

    const [, , constants, previousHeader] = proverFactory.createBlocksOnlySubTreeOrchestrator.mock.calls[0];
    expect(constants.slotNumber).toEqual(SlotNumber(5));
    expect(constants.coinbase).toEqual(block.header.globalVariables.coinbase);
    expect(previousHeader).toBe(chain.get(0)!.header);
    expect(subTrees[0].setBlockCompleted).toHaveBeenCalledWith(BlockNumber(1), block.header);
  });

  it('proves the blocks of a slot in order in one sub-tree, and starts a new sub-tree for the next slot', async () => {
    await propose(1, 5);
    await propose(2, 5);
    await propose(3, 6);

    prover.onChainProposed(BlockNumber(3));
    await provenBlocks(subTrees, 0, [1, 2]);
    await provenBlocks(subTrees, 1, [3]);

    expect(subTrees).toHaveLength(2);
    // The second slot starts from the last block of the first one.
    expect(proverFactory.createBlocksOnlySubTreeOrchestrator.mock.calls[1][3]).toBe(chain.get(2)!.header);
  });

  it('leaves checkpointed blocks to their checkpoint prover', async () => {
    await propose(1, 5);
    await propose(2, 6);
    checkpointedBlock = 1;

    prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 0, [2]);

    expect(subTrees).toHaveLength(1);
  });

  it('drops the oldest slot when a fifth slot starts without a checkpoint', async () => {
    // The oldest slot is still waiting for its transactions, so dropping it shows as its fetch being aborted.
    const oldest = await propose(1, 5);
    let oldestAborted = false;
    txProvider.getTxsForBlock.mockImplementation((block, opts) => {
      if (block !== oldest) {
        return Promise.resolve({ txs: [], missingTxs: [] });
      }
      const signal = opts.signal!;
      return new Promise(resolve => {
        const onAbort = () => {
          oldestAborted = true;
          resolve({ txs: [], missingTxs: [] });
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort);
        }
      });
    });
    for (const blockNumber of [2, 3, 4]) {
      await propose(blockNumber, 4 + blockNumber);
    }
    prover.onChainProposed(BlockNumber(4));
    await provenBlocks(subTrees, 2, [4]);
    expect(oldestAborted).toBe(false);

    await propose(5, 9);
    prover.onChainProposed(BlockNumber(5));

    await retryFastUntil(() => oldestAborted, 'oldest slot dropped');
  });

  it('stops proving a slot once its checkpoint lands', async () => {
    await propose(1, 5);
    prover.onChainProposed(BlockNumber(1));
    await provenBlocks(subTrees, 0, [1]);

    checkpointedBlock = 1;
    prover.onChainCheckpointed(BlockNumber(1));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');

    // A later block of another slot is proven; the checkpointed block is not started again.
    await propose(2, 6);
    prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 1, [2]);
    expect(subTrees).toHaveLength(2);
  });

  it('drops a slot when one of its blocks is pruned, and proves the slot again from its first block', async () => {
    await propose(1, 5);
    const pruned = await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 0, [1, 2]);

    prover.onChainPruned(BlockNumber(1));
    await retryFastUntil(() => chonkCache.releaseForBlocks.mock.calls.length > 0, 'chonk proofs released');
    expect(subTrees[0].stop).toHaveBeenCalled();
    expect(chonkCache.releaseForBlocks).toHaveBeenCalledWith([pruned]);

    // A different block 2 replaces the pruned one. The surviving block 1 is proven again ahead of it, because
    // block 2's proving inputs depend on it.
    const replacement = await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 1, [1, 2]);
    expect(subTrees[1].setBlockCompleted).toHaveBeenCalledWith(BlockNumber(2), replacement.header);
  });

  it('gives up on a slot whose transactions cannot be found, and still proves the next slot', async () => {
    const unavailable = await propose(1, 5);
    await propose(2, 6);
    txProvider.getTxsForBlock.mockImplementation(block =>
      Promise.resolve({ txs: [], missingTxs: block === unavailable ? [TxHash.random()] : [] }),
    );

    prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 0, [2]);

    expect(subTrees).toHaveLength(1);
  });

  it('picks a block up on the next proposed tip after the archiver could not be read', async () => {
    await propose(1, 5);
    l2BlockSource.getBlocks.mockRejectedValueOnce(new Error('archiver unavailable'));
    prover.onChainProposed(BlockNumber(1));

    await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));

    await provenBlocks(subTrees, 0, [1, 2]);
  });

  it('fetches a long run of proposed blocks in several reads', async () => {
    // More blocks than one read returns, all in one slot.
    const blockNumbers = times(150, i => i + 1);
    for (const blockNumber of blockNumbers) {
      await propose(blockNumber, 5);
    }

    prover.onChainProposed(BlockNumber(150));

    await provenBlocks(subTrees, 0, blockNumbers);
  });

  it('re-executes a block with transactions and hands them to the sub-tree in block order', async () => {
    const block = await L2Block.random(BlockNumber(1), { txsPerBlock: 3, slotNumber: SlotNumber(5) });
    chain.set(1, block);
    // The second transaction has a public part, so its chonk verifier proof is started.
    const txs = block.body.txEffects.map((txEffect, index) =>
      mock<Tx>({
        getTxHash: () => txEffect.txHash,
        data: mock<Tx['data']>({ forPublic: index === 1 ? mock() : undefined }),
      }),
    );
    const processed = txs.map(() => mock<ProcessedTx>());
    // The provider returns the transactions out of order.
    txProvider.getTxsForBlock.mockResolvedValue({ txs: [txs[2], txs[0], txs[1]], missingTxs: [] });
    publicProcessorFactory.create.mockReturnValue(
      mock<PublicProcessor>({ process: () => Promise.resolve([processed, [], [], [], []]) as never }),
    );

    prover.onChainProposed(BlockNumber(1));
    await provenBlocks(subTrees, 0, [1]);

    expect(subTrees[0].startChonkVerifierCircuits).toHaveBeenCalledWith([txs[1]]);
    expect(subTrees[0].addTxs).toHaveBeenCalledWith(processed);
  });

  it('stops the sub-tree of a slot whose block fails to execute', async () => {
    await propose(1, 5);
    proverFactory.createBlocksOnlySubTreeOrchestrator.mockImplementationOnce(() => {
      const subTree = mock<CheckpointSubTreeOrchestrator>();
      subTree.startNewBlock.mockRejectedValue(new Error('world state unavailable'));
      subTrees.push(subTree);
      return Promise.resolve(subTree);
    });

    prover.onChainProposed(BlockNumber(1));

    await retryFastUntil(() => subTrees[0]?.stop.mock.calls.length > 0, 'failed sub-tree stopped');
  });

  it('waits on stop for a slot that was released just before', async () => {
    await propose(1, 5);
    prover.onChainProposed(BlockNumber(1));
    await provenBlocks(subTrees, 0, [1]);
    const subTreeStopped = promiseWithResolvers<void>();
    subTrees[0].stop.mockReturnValue(subTreeStopped.promise);

    prover.onChainCheckpointed(BlockNumber(1));
    let stopped = false;
    const stopPromise = prover.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);

    subTreeStopped.resolve();
    await stopPromise;
  });

  /** Adds a block with no transactions to the archiver's chain. */
  async function propose(blockNumber: number, slot: number): Promise<L2Block> {
    const block = await makeBlock(blockNumber, slot);
    chain.set(blockNumber, block);
    return block;
  }

  function makeBlock(blockNumber: number, slot: number): Promise<L2Block> {
    return L2Block.random(BlockNumber(blockNumber), { txsPerBlock: 0, slotNumber: SlotNumber(slot) });
  }
});

/** Waits until the sub-tree at `index` has completed exactly these blocks, in this order. */
async function provenBlocks(
  subTrees: MockProxy<CheckpointSubTreeOrchestrator>[],
  index: number,
  blockNumbers: number[],
): Promise<void> {
  const completed = () => subTrees[index]?.setBlockCompleted.mock.calls.map(([blockNumber]) => Number(blockNumber));
  await retryFastUntil(() => (completed()?.length ?? 0) >= blockNumbers.length, `blocks ${blockNumbers} proven`);
  expect(completed()).toEqual(blockNumbers);
}
