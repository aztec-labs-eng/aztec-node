import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { retryFastUntil } from '@aztec-labs/foundation/retry';
import { DateProvider } from '@aztec-labs/foundation/timer';
import type { EpochProverFactory } from '@aztec-labs/prover-client';
import type { CheckpointSubTreeOrchestrator, ChonkCache } from '@aztec-labs/prover-client/orchestrator';
import type { PublicProcessorFactory } from '@aztec-labs/simulator/server';
import { L2Block, type L2BlockSource } from '@aztec-labs/stdlib/block';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type {
  ForkMerkleTreeOperations,
  ITxProvider,
  WorldStateSynchronizer,
} from '@aztec-labs/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { TxHash } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

import { EarlyBlockProver } from './early-block-prover.js';

describe('EarlyBlockProver', () => {
  let l2BlockSource: MockProxy<L2BlockSource>;
  let proverFactory: MockProxy<EpochProverFactory>;
  let txProvider: MockProxy<ITxProvider>;
  let chonkCache: MockProxy<ChonkCache>;
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
    const publicProcessorFactory = mock<PublicProcessorFactory>();
    const dbProvider = mock<Pick<ForkMerkleTreeOperations, 'fork'>>();

    chain = new Map([[0, await makeBlock(0, 0)]]);
    checkpointedBlock = 0;
    subTrees = [];

    l2BlockSource.getL1Constants.mockResolvedValue({ ...EmptyL1RollupConstants, epochDuration: 4 });
    l2BlockSource.getBlockNumber.mockImplementation(() => Promise.resolve(BlockNumber(checkpointedBlock)));
    l2BlockSource.getBlocks.mockImplementation((query: any) =>
      Promise.resolve(
        [...chain.values()].filter(block => block.number >= query.from && block.number < query.from + query.limit),
      ),
    );
    l2BlockSource.getBlockData.mockImplementation((query: any) => {
      const block = chain.get(Number(query.number));
      return Promise.resolve(block && ({ header: block.header } as any));
    });
    l1ToL2MessageSource.getL1ToL2MessageRange.mockResolvedValue({ messages: [] } as any);
    txProvider.getTxsForBlock.mockResolvedValue({ txs: [], missingTxs: [] });
    dbProvider.fork.mockResolvedValue({ appendLeaves: () => Promise.resolve(), close: () => Promise.resolve() } as any);
    publicProcessorFactory.create.mockReturnValue({ process: () => Promise.resolve([[], []]) } as any);
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

    await prover.onChainProposed(BlockNumber(1));
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

    await prover.onChainProposed(BlockNumber(3));
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

    await prover.onChainProposed(BlockNumber(2));
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
    await prover.onChainProposed(BlockNumber(4));
    await provenBlocks(subTrees, 2, [4]);
    expect(oldestAborted).toBe(false);

    await propose(5, 9);
    await prover.onChainProposed(BlockNumber(5));

    await retryFastUntil(() => oldestAborted, 'oldest slot dropped');
  });

  it('stops proving a slot once its checkpoint lands', async () => {
    await propose(1, 5);
    await prover.onChainProposed(BlockNumber(1));
    await provenBlocks(subTrees, 0, [1]);

    checkpointedBlock = 1;
    prover.onChainCheckpointed(BlockNumber(1));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');

    // The same proposed tip again starts nothing: the block is checkpointed.
    await prover.onChainProposed(BlockNumber(1));
    expect(subTrees).toHaveLength(1);
  });

  it('drops a slot when one of its blocks is pruned, and proves the slot again from its first block', async () => {
    await propose(1, 5);
    const pruned = await propose(2, 5);
    await prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 0, [1, 2]);

    prover.onChainPruned(BlockNumber(1));
    await retryFastUntil(() => subTrees[0].stop.mock.calls.length > 0, 'sub-tree stopped');
    expect(chonkCache.releaseForBlocks).toHaveBeenCalledWith([pruned]);

    // A different block 2 replaces the pruned one. The surviving block 1 is proven again ahead of it, because
    // block 2's proving inputs depend on it.
    const replacement = await propose(2, 5);
    await prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 1, [1, 2]);
    expect(subTrees[1].setBlockCompleted).toHaveBeenCalledWith(BlockNumber(2), replacement.header);
  });

  it('gives up on a slot whose transactions cannot be found, and still proves the next slot', async () => {
    const unavailable = await propose(1, 5);
    await propose(2, 6);
    txProvider.getTxsForBlock.mockImplementation(block =>
      Promise.resolve({ txs: [], missingTxs: block === unavailable ? [TxHash.random()] : [] }),
    );

    await prover.onChainProposed(BlockNumber(2));
    await provenBlocks(subTrees, 0, [2]);

    expect(subTrees).toHaveLength(1);
  });

  it('does not throw when the archiver cannot be read', async () => {
    l2BlockSource.getBlocks.mockRejectedValue(new Error('archiver unavailable'));
    await propose(1, 5);

    await expect(prover.onChainProposed(BlockNumber(1))).resolves.toBeUndefined();
    expect(subTrees).toHaveLength(0);
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
