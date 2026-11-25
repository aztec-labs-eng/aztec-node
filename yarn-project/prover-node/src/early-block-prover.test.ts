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
  MerkleTreeWriteOperations,
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
  let l1ToL2MessageSource: MockProxy<L1ToL2MessageSource>;
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
    l1ToL2MessageSource = mock<L1ToL2MessageSource>();
    const worldState = mock<WorldStateSynchronizer>();
    publicProcessorFactory = mock<PublicProcessorFactory>();
    const dbProvider = mock<Pick<ForkMerkleTreeOperations, 'fork'>>();

    chain = new Map([[0, await makeBlock(0, 0)]]);
    checkpointedBlock = 0;
    subTrees = [];

    // One long epoch, so every slot the tests use is in the epoch of the genesis block.
    l2BlockSource.getL1Constants.mockResolvedValue({ ...EmptyL1RollupConstants, epochDuration: 1000 });
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
      subTree.getSubTreeResult.mockReturnValue(new Promise(() => {}));
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
    await completedBlocks(subTrees, 0, [1]);

    const [, , constants, previousHeader] = proverFactory.createBlocksOnlySubTreeOrchestrator.mock.calls[0];
    expect(constants.slotNumber).toEqual(SlotNumber(5));
    expect(constants.coinbase).toEqual(block.header.globalVariables.coinbase);
    expect(previousHeader).toBe(chain.get(0)!.header);
    expect(subTrees[0].setBlockCompleted).toHaveBeenCalledWith(BlockNumber(1), block.header);
    // The block's messages are those between its parent's inbox leaf count and its own.
    expect(l1ToL2MessageSource.getL1ToL2MessageRange).toHaveBeenCalledWith(
      BigInt(chain.get(0)!.header.state.l1ToL2MessageTree.nextAvailableLeafIndex),
      BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex),
    );
  });

  it('proves the blocks of a slot in order in one sub-tree, and starts a new sub-tree for the next slot', async () => {
    await propose(1, 5);
    await propose(2, 5);
    await propose(3, 6);

    prover.onChainProposed(BlockNumber(3));
    await completedBlocks(subTrees, 0, [1, 2]);
    await completedBlocks(subTrees, 1, [3]);

    expect(subTrees).toHaveLength(2);
    // The second slot starts from the last block of the first one.
    expect(proverFactory.createBlocksOnlySubTreeOrchestrator.mock.calls[1][3]).toBe(chain.get(2)!.header);
  });

  it('leaves checkpointed blocks to their checkpoint prover', async () => {
    await propose(1, 5);
    await propose(2, 6);
    checkpointedBlock = 1;

    prover.onChainProposed(BlockNumber(2));
    await completedBlocks(subTrees, 0, [2]);

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
    await completedBlocks(subTrees, 2, [4]);
    expect(oldestAborted).toBe(false);

    await propose(5, 9);
    prover.onChainProposed(BlockNumber(5));

    await retryFastUntil(() => oldestAborted, 'oldest slot dropped');
    // Nothing tracks the dropped slot any more, so its chonk-verifier entries are released with it.
    await retryFastUntil(() => chonkCache.releaseForBlocks.mock.calls.length > 0, 'chonk proofs released');
    expect(chonkCache.releaseForBlocks).toHaveBeenCalledWith([oldest]);
  });

  it('stops proving a slot once its checkpoint lands', async () => {
    await propose(1, 5);
    prover.onChainProposed(BlockNumber(1));
    await completedBlocks(subTrees, 0, [1]);

    checkpointedBlock = 1;
    prover.onChainCheckpointed(BlockNumber(1));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');

    // A later block of another slot is proven; the checkpointed block is not started again.
    await propose(2, 6);
    prover.onChainProposed(BlockNumber(2));
    await completedBlocks(subTrees, 1, [2]);
    expect(subTrees).toHaveLength(2);
  });

  it('drops a slot when one of its blocks is pruned, and proves the slot again from its first block', async () => {
    await propose(1, 5);
    const pruned = await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await completedBlocks(subTrees, 0, [1, 2]);

    prover.onChainPruned(BlockNumber(1));
    await retryFastUntil(() => chonkCache.releaseForBlocks.mock.calls.length > 0, 'chonk proofs released');
    expect(subTrees[0].stop).toHaveBeenCalled();
    expect(chonkCache.releaseForBlocks).toHaveBeenCalledWith([pruned]);

    // A different block 2 replaces the pruned one. The surviving block 1 is proven again ahead of it, because
    // block 2's proving inputs depend on it.
    const replacement = await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await completedBlocks(subTrees, 1, [1, 2]);
    expect(subTrees[1].setBlockCompleted).toHaveBeenCalledWith(BlockNumber(2), replacement.header);
  });

  it('gives up on a slot whose transactions cannot be found, and still proves the next slot', async () => {
    const unavailable = await propose(1, 5);
    await propose(2, 6);
    txProvider.getTxsForBlock.mockImplementation(block =>
      Promise.resolve({ txs: [], missingTxs: block === unavailable ? [TxHash.random()] : [] }),
    );

    prover.onChainProposed(BlockNumber(2));
    await completedBlocks(subTrees, 0, [2]);

    expect(subTrees).toHaveLength(1);
  });

  it('picks a block up on the next proposed tip after the archiver could not be read', async () => {
    await propose(1, 5);
    l2BlockSource.getBlocks.mockRejectedValueOnce(new Error('archiver unavailable'));
    prover.onChainProposed(BlockNumber(1));

    await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));

    await completedBlocks(subTrees, 0, [1, 2]);
  });

  it('fetches a long run of proposed blocks in several reads', async () => {
    // More blocks than one read returns: three slots of fifty blocks each.
    const blocksPerSlot = 50;
    for (const blockNumber of times(3 * blocksPerSlot, i => i + 1)) {
      await propose(blockNumber, 5 + Math.floor((blockNumber - 1) / blocksPerSlot));
    }

    prover.onChainProposed(BlockNumber(3 * blocksPerSlot));

    // The third slot starts after the first read ends.
    await completedBlocks(
      subTrees,
      2,
      times(blocksPerSlot, i => 2 * blocksPerSlot + i + 1),
    );
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
    const processedByTx = new Map<Tx, ProcessedTx>(txs.map(tx => [tx, mock<ProcessedTx>()]));
    // The provider returns the transactions out of order. Execution keeps the order it is given.
    txProvider.getTxsForBlock.mockResolvedValue({ txs: [txs[2], txs[0], txs[1]], missingTxs: [] });
    publicProcessorFactory.create.mockReturnValue(
      mock<PublicProcessor>({
        process: (toProcess: Iterable<Tx> | AsyncIterable<Tx>) =>
          Promise.resolve([[...(toProcess as Tx[])].map(tx => processedByTx.get(tx)!), [], [], [], []]) as never,
      }),
    );

    prover.onChainProposed(BlockNumber(1));
    await completedBlocks(subTrees, 0, [1]);

    expect(subTrees[0].startChonkVerifierCircuits).toHaveBeenCalledWith([txs[1]]);
    expect(subTrees[0].addTxs).toHaveBeenCalledWith(txs.map(tx => processedByTx.get(tx)!));
  });

  it('stops the sub-tree of a slot whose block fails to execute', async () => {
    await propose(1, 5);
    proverFactory.createBlocksOnlySubTreeOrchestrator.mockImplementationOnce(() => {
      const subTree = mock<CheckpointSubTreeOrchestrator>();
      subTree.getSubTreeResult.mockReturnValue(new Promise(() => {}));
      subTree.startNewBlock.mockRejectedValue(new Error('world state unavailable'));
      subTrees.push(subTree);
      return Promise.resolve(subTree);
    });

    prover.onChainProposed(BlockNumber(1));

    await retryFastUntil(() => subTrees[0]?.stop.mock.calls.length > 0, 'failed sub-tree stopped');
    expect(subTrees[0].startNewBlock).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a block proposed before any checkpoint of its epoch has landed', async () => {
    // Epochs hold four slots. The checkpointed tip is in epoch 1; block 2 is the first block of epoch 2.
    l2BlockSource.getL1Constants.mockResolvedValue({ ...EmptyL1RollupConstants, epochDuration: 4 });
    await propose(1, 5);
    checkpointedBlock = 1;
    await propose(2, 8);
    await propose(3, 8);
    prover.onChainProposed(BlockNumber(3));
    // Blocks 2 and 3 are read while the checkpointed tip is still in epoch 1, and are not proven.
    await retryFastUntil(() => l2BlockSource.getBlocks.mock.calls.length > 0, 'proposed blocks read');
    expect(subTrees).toHaveLength(0);

    // The first checkpoint of epoch 2 lands, and the next slot of that epoch is proven early.
    checkpointedBlock = 3;
    prover.onChainCheckpointed(BlockNumber(3));
    await propose(4, 9);
    prover.onChainProposed(BlockNumber(4));
    await completedBlocks(subTrees, 0, [4]);

    expect(subTrees).toHaveLength(1);
  });

  it('stops proving a slot early when one of its proving jobs fails after its block was executed', async () => {
    await propose(1, 5);
    const jobFailed = promiseWithResolvers<never>();
    proverFactory.createBlocksOnlySubTreeOrchestrator.mockImplementationOnce(() => {
      const subTree = mock<CheckpointSubTreeOrchestrator>();
      subTree.whenBlockRootProven.mockReturnValue(new Promise(() => {}));
      subTree.getSubTreeResult.mockReturnValue(jobFailed.promise);
      subTrees.push(subTree);
      return Promise.resolve(subTree);
    });
    prover.onChainProposed(BlockNumber(1));
    await completedBlocks(subTrees, 0, [1]);

    jobFailed.reject(new Error('agent out of memory'));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');

    // The next block of the slot is not executed.
    await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await propose(3, 6);
    prover.onChainProposed(BlockNumber(3));
    await completedBlocks(subTrees, 1, [3]);
    expect(subTrees[0].setBlockCompleted).toHaveBeenCalledTimes(1);
  });

  it('does not start the slot again when a job fails while its next block is gathering transactions', async () => {
    await propose(1, 5);
    const jobFailed = promiseWithResolvers<never>();
    proverFactory.createBlocksOnlySubTreeOrchestrator.mockImplementationOnce(() => {
      const subTree = mock<CheckpointSubTreeOrchestrator>();
      subTree.whenBlockRootProven.mockReturnValue(new Promise(() => {}));
      subTree.getSubTreeResult.mockReturnValue(jobFailed.promise);
      subTrees.push(subTree);
      return Promise.resolve(subTree);
    });
    prover.onChainProposed(BlockNumber(1));
    await completedBlocks(subTrees, 0, [1]);

    const txsFetched = promiseWithResolvers<{ txs: Tx[]; missingTxs: TxHash[] }>();
    txProvider.getTxsForBlock.mockReturnValueOnce(txsFetched.promise);
    await propose(2, 5);
    prover.onChainProposed(BlockNumber(2));
    await retryFastUntil(() => txProvider.getTxsForBlock.mock.calls.length === 2, 'block 2 gathering its txs');
    jobFailed.reject(new Error('agent out of memory'));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');
    txsFetched.resolve({ txs: [], missingTxs: [] });

    // The next sub-tree is the one of the next slot.
    await propose(3, 6);
    prover.onChainProposed(BlockNumber(3));
    await completedBlocks(subTrees, 1, [3]);
  });

  it('waits on stop for a slot that was released just before', async () => {
    await propose(1, 5);
    prover.onChainProposed(BlockNumber(1));
    await completedBlocks(subTrees, 0, [1]);
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

/**
 * Waits until the sub-tree at `index` has been given these blocks to complete, in this order. The sub-trees are
 * mocks, so nothing is proven.
 */
async function completedBlocks(
  subTrees: MockProxy<CheckpointSubTreeOrchestrator>[],
  index: number,
  blockNumbers: number[],
): Promise<void> {
  const completed = () => subTrees[index]?.setBlockCompleted.mock.calls.map(([blockNumber]) => Number(blockNumber));
  await retryFastUntil(() => (completed()?.length ?? 0) >= blockNumbers.length, `blocks ${blockNumbers} completed`);
  expect(completed()).toEqual(blockNumbers);
}
