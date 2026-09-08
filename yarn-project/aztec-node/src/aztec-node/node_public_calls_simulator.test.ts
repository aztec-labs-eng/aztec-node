import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { unfreeze } from '@aztec-labs/foundation/types';
import { type AvmSimulator, PublicProcessor, PublicProcessorFactory } from '@aztec-labs/simulator/server';
import {
  type BlockData,
  BlockHash,
  L2Block,
  type L2BlockSource,
  type L2Frontier,
  type L2Tips,
} from '@aztec-labs/stdlib/block';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import { EmptyL1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import { GasFees } from '@aztec-labs/stdlib/gas';
import type { MerkleTreeWriteOperations, WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { InboxBucket, L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { mockTx } from '@aztec-labs/stdlib/testing';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import { BlockHeader, GlobalVariables, TxEffect } from '@aztec-labs/stdlib/tx';
import { WorldStateSynchronizerError } from '@aztec-labs/world-state';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import type { NextBlockPlan, NextBlockPredictor } from './next_block/index.js';
import { NodePublicCallsSimulator } from './node_public_calls_simulator.js';

const CHAIN_ID = new Fr(12345);
const ROLLUP_VERSION = new Fr(1);
const LATEST_BLOCK = BlockNumber(5);
const LATEST_BLOCK_HASH = new BlockHash(new Fr(0xb5)).toString();
/** Last block of the in-progress checkpoint's parent, for the mid-checkpoint message cap origin. */
const CHECKPOINT_PARENT_BLOCK = BlockNumber(3);

describe('NodePublicCallsSimulator', () => {
  let blockSource: MockProxy<L2BlockSource>;
  let worldStateSynchronizer: MockProxy<WorldStateSynchronizer>;
  let l1ToL2MessageSource: MockProxy<L1ToL2MessageSource>;
  let contractDataSource: MockProxy<ContractDataSource>;
  let epochCache: MockProxy<EpochCacheInterface>;
  let predictor: MockProxy<NextBlockPredictor>;
  let merkleTreeFork: MockProxy<MerkleTreeWriteOperations>;
  let avmSimulator: MockProxy<AvmSimulator>;

  let simulator: NodePublicCallsSimulator;

  // Captures the globals the simulator hands the processor, so tests assert on the result rather than on mocks.
  let builtGlobals: GlobalVariables | undefined;

  const globalsFor = (blockNumber: BlockNumber, slotNumber: SlotNumber) =>
    GlobalVariables.empty({ blockNumber, slotNumber, gasFees: new GasFees(0, 100) });

  const boundaryPlan = (): NextBlockPlan => ({
    latestBlockNumber: LATEST_BLOCK,
    latestBlockHash: LATEST_BLOCK_HASH,
    newCheckpoint: {
      targetSlot: SlotNumber(20),
      targetCheckpoint: CheckpointNumber(2),
      proposedCheckpointData: undefined,
      checkpointedCheckpointNumber: CheckpointNumber(1),
    },
  });

  const midCheckpointPlan = (): NextBlockPlan => ({
    latestBlockNumber: LATEST_BLOCK,
    latestBlockHash: LATEST_BLOCK_HASH,
  });

  /**
   * Only the fields the simulator itself reads off the snapshot: the terminating block of the
   * proposed-checkpoint frontier, which a mid-checkpoint message prediction counts its cap from.
   */
  const frontierWithCheckpointedBlock = (blockNumber: BlockNumber) =>
    ({
      proposedCheckpoint: undefined,
      tips: { checkpointed: { block: { number: blockNumber } } } as L2Tips,
    }) as L2Frontier;

  const mockPrediction = (plan: NextBlockPlan) =>
    predictor.predict.mockResolvedValue({
      plan,
      frontier: frontierWithCheckpointedBlock(CHECKPOINT_PARENT_BLOCK),
      globals: globalsFor(BlockNumber.add(plan.latestBlockNumber, 1), SlotNumber(20)),
    });

  /**
   * Answers the by-number read the mid-checkpoint message prediction makes for the parent block of the
   * in-progress checkpoint. Only the header's L1-to-L2 message total is read from it.
   */
  const mockCheckpointStartBlockData = (blockNumber: BlockNumber) =>
    blockSource.getBlockData.mockResolvedValue({
      header: BlockHeader.empty(),
      archive: L2Block.empty().archive,
      blockHash: new BlockHash(new Fr(1000 + blockNumber)),
      checkpointNumber: CheckpointNumber(1),
      indexWithinCheckpoint: IndexWithinCheckpoint(0),
    } satisfies BlockData);

  /**
   * Mocks the Inbox so the next-block prediction selects a two-message bundle: the fork's message total (0)
   * resolves to bucket 0, and bucket 1 is lag-eligible and holds both messages.
   */
  const mockInboxSelection = () => {
    const makeBucket = (seq: bigint, totalMsgCount: bigint): InboxBucket => ({
      seq,
      inboxRollingHash: Fr.ZERO,
      totalMsgCount,
      timestamp: 0n,
      msgCount: Number(totalMsgCount),
      lastMessageIndex: totalMsgCount === 0n ? 0n : totalMsgCount - 1n,
    });
    const bundle = [new Fr(0x1234), new Fr(0x5678)];
    l1ToL2MessageSource.getInboxBucketByTotalMsgCount.mockResolvedValue(makeBucket(0n, 0n));
    l1ToL2MessageSource.getLatestInboxBucketAtOrBefore.mockResolvedValue(makeBucket(1n, 2n));
    l1ToL2MessageSource.getL1ToL2MessagesBetweenBuckets.mockResolvedValue(bundle);
    return bundle;
  };

  const lowGasTx = () =>
    mockTx(0x10000, {
      numberOfNonRevertiblePublicCallRequests: 0,
      numberOfRevertiblePublicCallRequests: 0,
      chainId: CHAIN_ID,
      version: ROLLUP_VERSION,
    });

  beforeEach(() => {
    builtGlobals = undefined;

    blockSource = mock<L2BlockSource>();
    worldStateSynchronizer = mock<WorldStateSynchronizer>();
    l1ToL2MessageSource = mock<L1ToL2MessageSource>();
    contractDataSource = mock<ContractDataSource>();
    epochCache = mock<EpochCacheInterface>();
    predictor = mock<NextBlockPredictor>();
    merkleTreeFork = mock<MerkleTreeWriteOperations>();
    avmSimulator = mock<AvmSimulator>();

    worldStateSynchronizer.syncImmediate.mockResolvedValue(LATEST_BLOCK);
    // The fork is an AsyncDisposable; provide the hook so `await using` does not throw.
    (merkleTreeFork as unknown as { [Symbol.asyncDispose]: () => Promise<void> })[Symbol.asyncDispose] = () =>
      Promise.resolve();
    worldStateSynchronizer.fork.mockResolvedValue(merkleTreeFork);
    merkleTreeFork.getTreeInfo.mockResolvedValue({
      treeId: MerkleTreeId.L1_TO_L2_MESSAGE_TREE,
      root: Buffer.alloc(32),
      size: 0n,
      depth: 16,
    });
    // No Inbox bucket resolves to the fork's message total by default, so the next-block message prediction
    // bails out and tests see the bare tip state unless they opt into it.
    l1ToL2MessageSource.getInboxBucketByTotalMsgCount.mockResolvedValue(undefined);
    epochCache.getL1Constants.mockReturnValue(EmptyL1RollupConstants);
    mockPrediction(boundaryPlan());

    // Capture the globals passed to the public processor and short-circuit execution with a stub
    // processor that echoes them back, so `simulate` returns an output reflecting the chosen globals.
    jest
      .spyOn(PublicProcessorFactory.prototype, 'create')
      .mockImplementation((_fork, globalVariables: GlobalVariables) => {
        builtGlobals = globalVariables;
        const processedTx = {
          revertReason: undefined,
          globalVariables,
          txEffect: TxEffect.empty(),
          gasUsed: { totalGas: undefined, teardownGas: undefined, publicGas: undefined, billedGas: undefined },
        };
        return {
          process: () => Promise.resolve([[processedTx], [], [], [], []]),
        } as unknown as PublicProcessor;
      });

    simulator = new NodePublicCallsSimulator({
      blockSource,
      worldStateSynchronizer,
      l1ToL2MessageSource,
      contractDataSource,
      predictor,
      epochCache,
      avmSimulator,
      config: { rpcSimulatePublicMaxGasLimit: 1e11, rpcSimulatePublicMaxDebugLogMemoryReads: 100 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects when the gas limit exceeds the maximum', async () => {
    const tx = await lowGasTx();
    unfreeze(tx.data.constants.txContext.gasSettings.gasLimits).l2Gas = 1e12;

    await expect(simulator.simulate(tx)).rejects.toThrow(/gas/i);
    expect(predictor.predict).not.toHaveBeenCalled();
  });

  it('simulates the block the predictor planned, on a fork of the block it builds on', async () => {
    const output = await simulator.simulate(await lowGasTx());

    expect(worldStateSynchronizer.syncImmediate).toHaveBeenCalledWith(
      LATEST_BLOCK,
      BlockHash.fromString(LATEST_BLOCK_HASH),
    );
    expect(worldStateSynchronizer.fork).toHaveBeenCalledWith(LATEST_BLOCK);
    expect(builtGlobals).toEqual(globalsFor(BlockNumber(6), SlotNumber(20)));
    expect(output.globalVariables).toEqual(builtGlobals);
  });

  it('appends the message bundle a checkpoint-opening block would consume', async () => {
    const bundle = mockInboxSelection();

    await simulator.simulate(await lowGasTx());

    // A fresh checkpoint starts its per-checkpoint budget at the tip, so no parent block is read for it.
    expect(blockSource.getBlockData).not.toHaveBeenCalled();
    expect(merkleTreeFork.appendLeaves).toHaveBeenCalledWith(MerkleTreeId.L1_TO_L2_MESSAGE_TREE, bundle);
  });

  it('counts the per-checkpoint cap from the parent block when continuing a checkpoint', async () => {
    mockPrediction(midCheckpointPlan());
    mockCheckpointStartBlockData(CHECKPOINT_PARENT_BLOCK);
    const bundle = mockInboxSelection();

    await simulator.simulate(await lowGasTx());

    expect(blockSource.getBlockData).toHaveBeenCalledWith({ number: CHECKPOINT_PARENT_BLOCK });
    expect(merkleTreeFork.appendLeaves).toHaveBeenCalledWith(MerkleTreeId.L1_TO_L2_MESSAGE_TREE, bundle);
  });

  it('simulates against the tip when the parent Inbox bucket is not synced', async () => {
    // Default mock: no bucket resolves the fork's message total.
    await expect(simulator.simulate(await lowGasTx())).resolves.toBeDefined();

    expect(merkleTreeFork.appendLeaves).not.toHaveBeenCalled();
  });

  it('simulates against the tip when the Inbox read fails', async () => {
    l1ToL2MessageSource.getInboxBucketByTotalMsgCount.mockRejectedValue(new Error('archiver is down'));

    await expect(simulator.simulate(await lowGasTx())).resolves.toBeDefined();
    expect(merkleTreeFork.appendLeaves).not.toHaveBeenCalled();
  });

  it('replans once when the world state holds a different block at the planned height', async () => {
    worldStateSynchronizer.syncImmediate.mockRejectedValueOnce(hashMismatch());
    predictor.predict
      .mockResolvedValueOnce({
        plan: boundaryPlan(),
        frontier: frontierWithCheckpointedBlock(CHECKPOINT_PARENT_BLOCK),
        globals: globalsFor(BlockNumber(6), SlotNumber(20)),
      })
      .mockResolvedValueOnce({
        plan: boundaryPlan(),
        frontier: frontierWithCheckpointedBlock(CHECKPOINT_PARENT_BLOCK),
        globals: globalsFor(BlockNumber(6), SlotNumber(21)),
      });

    await simulator.simulate(await lowGasTx());

    expect(predictor.predict).toHaveBeenCalledTimes(2);
    expect(builtGlobals!.slotNumber).toEqual(SlotNumber(21));
  });

  it('fails with a retryable error when the world state keeps disagreeing with the plan', async () => {
    worldStateSynchronizer.syncImmediate.mockRejectedValue(hashMismatch());

    await expect(simulator.simulate(await lowGasTx())).rejects.toThrow(/prune race/);
    expect(predictor.predict).toHaveBeenCalledTimes(2);
    expect(worldStateSynchronizer.fork).not.toHaveBeenCalled();
  });

  it('surfaces a block the world state cannot reach without replanning', async () => {
    worldStateSynchronizer.syncImmediate.mockRejectedValue(
      new WorldStateSynchronizerError('unable to sync', { cause: { reason: 'block_not_available' } }),
    );

    await expect(simulator.simulate(await lowGasTx())).rejects.toThrow('unable to sync');
    expect(predictor.predict).toHaveBeenCalledTimes(1);
  });

  it('surfaces any other sync failure without replanning', async () => {
    worldStateSynchronizer.syncImmediate.mockRejectedValue(new Error('world state is down'));

    await expect(simulator.simulate(await lowGasTx())).rejects.toThrow('world state is down');
    expect(predictor.predict).toHaveBeenCalledTimes(1);
  });

  const hashMismatch = () =>
    new WorldStateSynchronizerError('hash mismatch', { cause: { reason: 'block_hash_mismatch' } });
});
