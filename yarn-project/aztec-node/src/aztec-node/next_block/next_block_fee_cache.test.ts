import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryFastUntil } from '@aztec-labs/foundation/retry';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import {
  type ArchiverEmitter,
  type L1SyncPoint,
  type L2BlockSourceEventEmitter,
  L2BlockSourceEvents,
  type L2Frontier,
} from '@aztec-labs/stdlib/block';
import { GasFees } from '@aztec-labs/stdlib/gas';
import type { CheckpointGlobalVariables, GlobalVariableBuilder } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { type MockProxy, mock } from 'jest-mock-extended';

import { NextBlockFeeCache } from './next_block_fee_cache.js';
import { NextBlockPredictor } from './next_block_predictor.js';
import {
  type L2FrontierArgs,
  blockHashOf,
  makeFeeHeader,
  makeFrontier,
  makeInvalidStatus,
  makeProposedCheckpointData,
} from './test_helpers.js';

const CHAIN_ID = new Fr(12345);
const ROLLUP_VERSION = new Fr(1);

describe('NextBlockFeeCache', () => {
  let blockSource: MockProxy<L2BlockSourceEventEmitter>;
  let globalVariableBuilder: MockProxy<GlobalVariableBuilder>;
  let rollupContract: MockProxy<RollupContract>;
  let epochCache: MockProxy<EpochCacheInterface>;
  let cache: NextBlockFeeCache;

  /** Distinct fee per pricing call, so a re-price is visible in the value a reader gets back. */
  let priceCount: number;

  const syncPoint = (seed: number): L1SyncPoint => ({
    blockNumber: BigInt(seed),
    blockHash: Buffer32.fromField(new Fr(seed)),
  });

  const boundaryArgs = (args: Partial<L2FrontierArgs> = {}): L2FrontierArgs => ({
    proposed: BlockNumber(5),
    checkpointedBlock: BlockNumber(5),
    checkpointed: CheckpointNumber(1),
    checkpointedTipSlot: SlotNumber(5),
    l1SyncPoint: syncPoint(1),
    ...args,
  });

  const setFrontier = (args: Partial<L2FrontierArgs> = {}): L2Frontier => {
    const frontier = makeFrontier(boundaryArgs(args));
    blockSource.getL2Frontier.mockResolvedValue(frontier);
    return frontier;
  };

  const globalsFor = (slotNumber: SlotNumber, feePerL2Gas: number): CheckpointGlobalVariables => ({
    chainId: CHAIN_ID,
    version: ROLLUP_VERSION,
    slotNumber,
    timestamp: BigInt(slotNumber) * 72n,
    coinbase: EthAddress.ZERO,
    feeRecipient: AztecAddress.ZERO,
    gasFees: new GasFees(0, feePerL2Gas),
  });

  /** The seed of the sync point a pricing call was pinned to, whether it was pinned by hash or by number. */
  const pinnedSeed = (options?: { blockNumber?: bigint; blockHash?: string }): number =>
    options?.blockHash !== undefined ? Number(BigInt(options.blockHash)) : Number(options?.blockNumber ?? 0n);

  /** Prices every boundary at `slot * 1000 + seed of the L1 sync point it was pinned to`. */
  const priceBySyncPoint = () =>
    globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementation((_c, _f, slotNumber, _plan, options) =>
      Promise.resolve(globalsFor(slotNumber, slotNumber * 1000 + pinnedSeed(options))),
    );

  /** Holds the next pricing call until released, so a test can move the frontier while it is in flight. */
  const gateNextPricing = () => {
    const started = promiseWithResolvers<void>();
    const gate = promiseWithResolvers<void>();
    const price = globalVariableBuilder.buildCheckpointGlobalVariables.getMockImplementation()!;
    globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementationOnce(async (...args) => {
      started.resolve();
      await gate.promise;
      return price(...args);
    });
    return { started: started.promise, release: () => gate.resolve() };
  };

  /** Answers the grandparent fee header and mana target reads a pipelined plan makes. */
  const mockGrandparentReads = (manaTarget = 1000n) =>
    rollupContract.getCheckpointAndManaTarget.mockResolvedValue({
      checkpoint: { feeHeader: makeFeeHeader() } as never,
      manaTarget,
    });

  /** The fee a reader planning from the clock is served, waiting for it without a cap. */
  const boundaryFee = async () => (await cache.lookupNextBlock()).record?.globals.gasFees;

  beforeEach(() => {
    priceCount = 0;
    blockSource = mock<L2BlockSourceEventEmitter>();
    blockSource.events = new EventEmitter() as ArchiverEmitter;
    globalVariableBuilder = mock<GlobalVariableBuilder>();
    rollupContract = mock<RollupContract>();
    epochCache = mock<EpochCacheInterface>();

    epochCache.getEpochAndSlotInNextL1Slot.mockReturnValue({
      epoch: EpochNumber.ZERO,
      slot: SlotNumber(19),
      ts: 0n,
      nowSeconds: 0n,
    });
    globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementation((_c, _f, slotNumber) =>
      Promise.resolve(globalsFor(slotNumber, ++priceCount)),
    );

    cache = new NextBlockFeeCache({
      blockSource,
      globalVariableBuilder,
      rollupContract,
      epochCache,
      signatureContext: { chainId: CHAIN_ID.toNumber(), rollupAddress: EthAddress.random() },
    });
  });

  afterEach(async () => {
    await cache.stop();
    jest.restoreAllMocks();
  });

  it('prices the boundary the frontier describes, pinned to its L1 block', async () => {
    setFrontier({ l1SyncPoint: syncPoint(42) });

    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 1));
    const [coinbase, feeRecipient, slot, , options] =
      globalVariableBuilder.buildCheckpointGlobalVariables.mock.calls[0];
    expect(coinbase).toEqual(EthAddress.ZERO);
    expect(feeRecipient).toEqual(AztecAddress.ZERO);
    // Clock slot 19 + the pipelining offset.
    expect(slot).toEqual(SlotNumber(20));
    expect(options?.blockHash).toEqual(syncPoint(42).blockHash.toString());
  });

  it('skips the re-price when neither the key nor the L1 sync point moved', async () => {
    setFrontier();
    await cache.refresh();

    await cache.refresh();

    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 1));
  });

  it('re-prices when the key moves', async () => {
    setFrontier();
    await cache.refresh();

    setFrontier({ checkpointedTipSlot: SlotNumber(30) });
    await cache.refresh();

    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(2);
    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 2));
  });

  it('keeps serving a reader one L1 block ahead of the record until the loop re-prices', async () => {
    setFrontier({ l1SyncPoint: syncPoint(1) });
    await cache.refresh();
    setFrontier({ l1SyncPoint: syncPoint(2) });

    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 1));

    await cache.refresh();

    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(2);
    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 2));
  });

  it('re-prices for a reader two L1 blocks ahead of the record', async () => {
    setFrontier({ l1SyncPoint: syncPoint(1) });
    await cache.refresh();
    setFrontier({ l1SyncPoint: syncPoint(3) });

    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 2));
  });

  it('shares one in-flight refresh between concurrent readers and the loop', async () => {
    setFrontier();
    const gate = promiseWithResolvers<CheckpointGlobalVariables>();
    globalVariableBuilder.buildCheckpointGlobalVariables.mockReturnValueOnce(gate.promise);

    const first = boundaryFee();
    const second = boundaryFee();
    const loopPass = cache.refresh();
    gate.resolve(globalsFor(SlotNumber(20), 7));

    const [firstFees, secondFees] = await Promise.all([first, second, loopPass]);

    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
    expect(firstFees).toEqual(new GasFees(0, 7));
    expect(secondFees).toEqual(new GasFees(0, 7));
  });

  it('keeps the record and serves a capped reader one block ahead of it while the refresh keeps failing', async () => {
    setFrontier({ l1SyncPoint: syncPoint(1) });
    await cache.refresh();
    setFrontier({ l1SyncPoint: syncPoint(2) });
    globalVariableBuilder.buildCheckpointGlobalVariables.mockRejectedValue(new Error('L1 is down'));

    await expect(cache.refresh()).rejects.toThrow('L1 is down');

    const { record } = await cache.lookupNextBlock(50);
    expect(record?.globals.gasFees).toEqual(new GasFees(0, 1));
  });

  it('gives a capped reader nothing once the failing refresh leaves the record more than a block behind', async () => {
    setFrontier({ l1SyncPoint: syncPoint(1) });
    await cache.refresh();
    setFrontier({ l1SyncPoint: syncPoint(3) });
    globalVariableBuilder.buildCheckpointGlobalVariables.mockRejectedValue(new Error('L1 is down'));

    expect((await cache.lookupNextBlock(50)).record).toBeUndefined();
  });

  it('gives up on a capped wait rather than hanging on a stalled L1 call', async () => {
    setFrontier();
    const stalled = promiseWithResolvers<CheckpointGlobalVariables>();
    globalVariableBuilder.buildCheckpointGlobalVariables.mockReturnValue(stalled.promise);

    expect((await cache.lookupNextBlock(20)).record).toBeUndefined();

    stalled.resolve(globalsFor(SlotNumber(20), 1));
  });

  it('starts the refresh without waiting for a reader with no budget to wait', async () => {
    setFrontier();

    expect((await cache.lookupNextBlock(0)).record).toBeUndefined();

    await retryFastUntil(async () => (await cache.lookupNextBlock(0)).record, 'refresh started by the reader');
    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
  });

  it('surfaces the L1 failure to an uncapped reader', async () => {
    setFrontier();
    globalVariableBuilder.buildCheckpointGlobalVariables.mockRejectedValue(new Error('L1 is down'));

    await expect(cache.lookupNextBlock()).rejects.toThrow('L1 is down');
  });

  it('starts idempotently and serves a read arriving during the first pass from that pass', async () => {
    setFrontier();

    cache.start();
    cache.start();

    await expect(boundaryFee()).resolves.toEqual(new GasFees(0, 1));
    expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
  });

  it('starts even when the first pass fails', async () => {
    setFrontier();
    globalVariableBuilder.buildCheckpointGlobalVariables.mockRejectedValue(new Error('L1 is down'));

    cache.start();

    await expect(boundaryFee()).rejects.toThrow('L1 is down');
    await expect(cache.stop()).resolves.toBeUndefined();
  });

  describe('background loop', () => {
    /**
     * The fee a reader is served without waiting. It starts no refresh of its own while the record is at most one L1
     * block behind the frontier, so it only changes when the loop re-prices.
     */
    const loopFee = () => cache.lookupNextBlock(0).then(lookup => lookup.record?.globals.gasFees);
    /** Whether any pricing call so far was pinned to the L1 sync point with this seed. */
    const pricedAt = (seed: number) =>
      globalVariableBuilder.buildCheckpointGlobalVariables.mock.calls.some(call => pinnedSeed(call[4]) === seed);

    beforeEach(() => priceBySyncPoint());

    it('re-prices on the next tick after an L1 block that moves only the fee oracle', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      cache.start(50);
      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_001)), 'first price');

      setFrontier({ l1SyncPoint: syncPoint(2) });

      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_002)), 're-price on tick');
    });

    it('re-prices on the next tick after a checkpoint proposal arrives for blocks it already had', async () => {
      // The blocks of proposed checkpoint 2 are local but its proposal is not: the next block continues it.
      setFrontier({ proposed: BlockNumber(6), latestBlockGlobals: { slotNumber: SlotNumber(19) } });
      cache.start(50);
      await retryFastUntil(() => blockSource.getL2Frontier.mock.calls.length > 1, 'first tick');
      expect(globalVariableBuilder.buildCheckpointGlobalVariables).not.toHaveBeenCalled();

      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(2),
        lastBlock: BlockNumber(6),
        slotNumber: SlotNumber(19),
      });
      mockGrandparentReads();
      setFrontier({ proposed: BlockNumber(6), proposedCheckpoint });

      await retryFastUntil(() => pricedAt(1), 'price on tick');
    });

    it('re-prices on an L1 sync point update without waiting for the tick', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      cache.start(60_000);
      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_001)), 'first price');

      setFrontier({ l1SyncPoint: syncPoint(2) });
      blockSource.events.emit(L2BlockSourceEvents.L1SyncPointUpdated, {
        type: 'l1SyncPointUpdated',
        l1SyncPoint: syncPoint(2),
      });

      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_002)), 're-price on event');
    });

    it('re-prices again right after a refresh a reader started for an older sync point', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      cache.start(60_000);
      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_001)), 'first price');

      setFrontier({ l1SyncPoint: syncPoint(3) });
      const readerPricing = gateNextPricing();
      const reader = cache.lookupNextBlock();
      await readerPricing.started;
      setFrontier({ l1SyncPoint: syncPoint(5) });
      blockSource.events.emit(L2BlockSourceEvents.L1SyncPointUpdated, {
        type: 'l1SyncPointUpdated',
        l1SyncPoint: syncPoint(5),
      });
      readerPricing.release();

      await retryFastUntil(() => pricedAt(5), 're-price after event');
      await expect(reader).resolves.toMatchObject({ record: { l1SyncPoint: syncPoint(5) } });
    });

    it('recovers on the next tick after a failed refresh, keeping the record meanwhile', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      cache.start(50);
      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_001)), 'first price');

      const failed = promiseWithResolvers<void>();
      globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementationOnce(() => {
        failed.resolve();
        return Promise.reject(new Error('L1 is down'));
      });
      setFrontier({ l1SyncPoint: syncPoint(2) });
      await failed.promise;
      expect(await loopFee()).toEqual(new GasFees(0, 20_001));

      await retryFastUntil(async () => (await loopFee())?.equals(new GasFees(0, 20_002)), 're-price after failure');
    });
  });

  describe('overrides plan', () => {
    const overridesPlanOf = () => globalVariableBuilder.buildCheckpointGlobalVariables.mock.calls[0][3];

    it('pins both tips to the checkpointed tip when the chain is idle', async () => {
      setFrontier();
      await cache.refresh();

      expect(overridesPlanOf()?.chainTipsOverride).toEqual({
        pending: CheckpointNumber(1),
        proven: CheckpointNumber(1),
      });
    });

    it('carries the proposed parent state when pipelining on a proposed checkpoint', async () => {
      const parentSlot = SlotNumber(30);
      const parentArchiveRoot = Fr.fromString('0xabcabc');
      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(3),
        lastBlock: BlockNumber(5),
        slotNumber: parentSlot,
        archiveRoot: parentArchiveRoot,
      });
      const grandparentFeeHeader = makeFeeHeader();
      rollupContract.getCheckpointAndManaTarget.mockResolvedValue({
        checkpoint: { feeHeader: grandparentFeeHeader } as never,
        manaTarget: 1000n,
      });
      const childFeeHeader = makeFeeHeader();
      jest.spyOn(RollupContract, 'computeChildFeeHeader').mockReturnValue(childFeeHeader);

      setFrontier({ checkpointed: CheckpointNumber(2), proposedCheckpoint });
      await cache.refresh();

      const [, , slot] = globalVariableBuilder.buildCheckpointGlobalVariables.mock.calls[0];
      expect(slot).toEqual(SlotNumber(31));
      expect(overridesPlanOf()?.pendingCheckpointState?.archive).toEqual(parentArchiveRoot);
      expect(overridesPlanOf()?.pendingCheckpointState?.slotNumber).toEqual(parentSlot);
      expect(overridesPlanOf()?.pendingCheckpointState?.feeHeader).toEqual(childFeeHeader);
      expect(RollupContract.computeChildFeeHeader).toHaveBeenCalledWith(
        grandparentFeeHeader,
        proposedCheckpoint.totalManaUsed,
        proposedCheckpoint.feeAssetPriceModifier,
        1000n,
      );
    });

    it("derives the proposed parent's fee header from the mana target at the frontier's L1 block", async () => {
      const frontierL1Block = 7;
      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(3),
        lastBlock: BlockNumber(5),
        slotNumber: SlotNumber(30),
      });
      const grandparentFeeHeader = { ...makeFeeHeader(), excessMana: 1500n, manaUsed: 0n };
      // Governance raised the target after the frontier's L1 block: L1's latest state has 2000, that block 1000.
      rollupContract.getCheckpointAndManaTarget.mockImplementation((_checkpointNumber, blockHash) =>
        Promise.resolve({
          checkpoint: { feeHeader: grandparentFeeHeader } as never,
          manaTarget: blockHash === syncPoint(frontierL1Block).blockHash.toString() ? 1000n : 2000n,
        }),
      );

      setFrontier({ checkpointed: CheckpointNumber(2), proposedCheckpoint, l1SyncPoint: syncPoint(frontierL1Block) });
      await cache.refresh();

      expect(overridesPlanOf()?.pendingCheckpointState?.feeHeader).toEqual(
        RollupContract.computeChildFeeHeader(
          grandparentFeeHeader,
          proposedCheckpoint.totalManaUsed,
          proposedCheckpoint.feeAssetPriceModifier,
          1000n,
        ),
      );
    });

    it('prices on the checkpointed tip until the archiver has an L1 sync point', async () => {
      // Without a sync point there is no L1 block to derive the proposed parent's fee header at.
      rollupContract.getCheckpoint.mockRejectedValue(new Error('Unexpected unpinned read'));
      rollupContract.getCheckpointAndManaTarget.mockRejectedValue(new Error('Unexpected unpinned read'));
      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(3),
        lastBlock: BlockNumber(5),
        slotNumber: SlotNumber(30),
      });

      setFrontier({ checkpointed: CheckpointNumber(2), proposedCheckpoint, l1SyncPoint: undefined });
      await cache.refresh();

      expect(overridesPlanOf()?.chainTipsOverride).toEqual({
        pending: CheckpointNumber(2),
        proven: CheckpointNumber(2),
      });
      expect(overridesPlanOf()?.pendingCheckpointState).toBeUndefined();
    });

    it('prices on the checkpointed tip when the frontier runs more than one checkpoint ahead of L1', async () => {
      // L1 keeps no `tempCheckpointLogs` cell for a checkpoint it has not seen, so the grandparent read the
      // pipelined fee header derives from reverts while the checkpoints between it and the tip are in flight.
      rollupContract.getCheckpointAndManaTarget.mockRejectedValue(new Error('Rollup__UnavailableTempCheckpointLog'));
      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(3),
        lastBlock: BlockNumber(5),
        slotNumber: SlotNumber(30),
      });

      setFrontier({ checkpointed: CheckpointNumber(1), proposedCheckpoint });
      await cache.refresh();

      expect(overridesPlanOf()?.chainTipsOverride).toEqual({
        pending: CheckpointNumber(1),
        proven: CheckpointNumber(1),
      });
      expect(overridesPlanOf()?.pendingCheckpointState).toBeUndefined();
    });

    it('pins tips to firstInvalid - 1 when the pending chain is invalid', async () => {
      setFrontier({
        checkpointed: CheckpointNumber(5),
        pendingChainValidationStatus: makeInvalidStatus(CheckpointNumber(4)),
      });
      await cache.refresh();

      expect(overridesPlanOf()?.chainTipsOverride).toEqual({
        pending: CheckpointNumber(3),
        proven: CheckpointNumber(3),
      });
    });

    describe('without a rollup contract, the TXE shape', () => {
      beforeEach(() => {
        cache = new NextBlockFeeCache({
          blockSource,
          globalVariableBuilder,
          epochCache,
          signatureContext: { chainId: CHAIN_ID.toNumber(), rollupAddress: EthAddress.random() },
        });
      });

      it('degrades to a pinned-tips plan when pipelining', async () => {
        const proposedCheckpoint = makeProposedCheckpointData({
          checkpointNumber: CheckpointNumber(3),
          lastBlock: BlockNumber(5),
          slotNumber: SlotNumber(30),
        });

        setFrontier({ checkpointed: CheckpointNumber(2), proposedCheckpoint });
        await cache.refresh();

        expect(overridesPlanOf()?.chainTipsOverride).toEqual({
          pending: CheckpointNumber(2),
          proven: CheckpointNumber(2),
        });
        expect(overridesPlanOf()?.pendingCheckpointState).toBeUndefined();
      });

      it('prices an idle chain', async () => {
        setFrontier();
        await cache.refresh();

        expect(overridesPlanOf()?.chainTipsOverride).toEqual({
          pending: CheckpointNumber(1),
          proven: CheckpointNumber(1),
        });
      });
    });
  });

  describe('getCheckpointOpeningGasFees', () => {
    const parentOf = (blockNumber: BlockNumber) => ({ number: blockNumber, hash: blockHashOf(blockNumber).toString() });

    beforeEach(() => {
      // A fee that tells the priced slot apart, so a result shows which boundary it was priced for.
      globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementation((_c, _f, slotNumber) =>
        Promise.resolve(globalsFor(slotNumber, slotNumber * 1000)),
      );
    });

    it("prices the proposal's slot rather than the slot this node's clock plans", async () => {
      setFrontier();

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(12), parentOf(BlockNumber(5)));

      expect(fees).toEqual(new GasFees(0, 12_000));
    });

    it('serves a boundary the loop already priced for that slot and parent from memory', async () => {
      setFrontier();
      await cache.refresh();

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)));

      expect(fees).toEqual(new GasFees(0, 20_000));
      expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
    });

    /** Makes every later pricing return a different fee, as an L1 fee oracle update that does not move the key would. */
    const moveL1Fees = () =>
      globalVariableBuilder.buildCheckpointGlobalVariables.mockImplementation((_c, _f, slotNumber) =>
        Promise.resolve(globalsFor(slotNumber, slotNumber * 1000 + 1)),
      );

    it("re-prices a record priced before the frontier's L1 block, though the key did not move", async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      await cache.refresh();
      moveL1Fees();
      setFrontier({ l1SyncPoint: syncPoint(2) });

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)));

      expect(fees).toEqual(new GasFees(0, 20_001));
    });

    it('re-prices a record priced at an L1 block that a reorg replaced at the same height', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      await cache.refresh();
      moveL1Fees();
      setFrontier({ l1SyncPoint: { blockNumber: 1n, blockHash: Buffer32.fromField(new Fr(99)) } });

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)));

      expect(fees).toEqual(new GasFees(0, 20_001));
    });

    it('re-prices a record priced at a later L1 block than the frontier, after a reorg to a lower block', async () => {
      setFrontier({ l1SyncPoint: syncPoint(2) });
      await cache.refresh();
      moveL1Fees();
      setFrontier({ l1SyncPoint: syncPoint(1) });

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)));

      expect(fees).toEqual(new GasFees(0, 20_001));
    });

    it('prices a validator whose parent checkpoint lands while it waits from the frontier it landed in', async () => {
      priceBySyncPoint();
      mockGrandparentReads();
      const parentCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(2),
        lastBlock: BlockNumber(5),
        slotNumber: SlotNumber(19),
      });
      setFrontier({ checkpointedBlock: BlockNumber(4), proposedCheckpoint: parentCheckpoint });
      const firstPricing = gateNextPricing();

      const fees = cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)));
      await firstPricing.started;
      // The parent's checkpoint lands on L1 while the first pricing is still in flight.
      setFrontier({
        checkpointed: CheckpointNumber(2),
        checkpointedTipSlot: SlotNumber(19),
        l1SyncPoint: syncPoint(2),
      });
      firstPricing.release();

      await expect(fees).resolves.toEqual(new GasFees(0, 20_002));
    });

    it('has no price when the proposed tip is not the proposal parent', async () => {
      setFrontier();

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(20), {
        number: BlockNumber(5),
        hash: blockHashOf(BlockNumber(6)).toString(),
      });

      expect(fees).toBeUndefined();
    });

    it("has no price until the parent's checkpoint is processed", async () => {
      // The parent's blocks are local but its checkpoint is not, so the frontier is still mid-checkpoint.
      setFrontier({ proposed: BlockNumber(7), latestBlockGlobals: { slotNumber: SlotNumber(30) } });

      const fees = await cache.getCheckpointOpeningGasFees(SlotNumber(31), parentOf(BlockNumber(7)));

      expect(fees).toBeUndefined();
      expect(globalVariableBuilder.buildCheckpointGlobalVariables).not.toHaveBeenCalled();
    });

    it("has no price while the checkpointed tip trails the parent's parent, then prices on the pipelined plan", async () => {
      const proposedCheckpoint = makeProposedCheckpointData({
        checkpointNumber: CheckpointNumber(3),
        lastBlock: BlockNumber(5),
        slotNumber: SlotNumber(30),
      });
      mockGrandparentReads();
      const childFeeHeader = makeFeeHeader();
      jest.spyOn(RollupContract, 'computeChildFeeHeader').mockReturnValue(childFeeHeader);

      // Checkpoint 2, the parent's parent, has not been checkpointed in this node's view yet.
      setFrontier({ checkpointed: CheckpointNumber(1), proposedCheckpoint });
      const trailing = await cache.getCheckpointOpeningGasFees(SlotNumber(31), parentOf(BlockNumber(5)));

      setFrontier({ checkpointed: CheckpointNumber(2), proposedCheckpoint });
      const caughtUp = await cache.getCheckpointOpeningGasFees(SlotNumber(31), parentOf(BlockNumber(5)));

      expect(trailing).toBeUndefined();
      expect(caughtUp).toEqual(new GasFees(0, 31_000));
      // The only price was the one read under the pipelined parent's fee header, never a pinned-tips one.
      expect(globalVariableBuilder.buildCheckpointGlobalVariables).toHaveBeenCalledTimes(1);
      expect(
        globalVariableBuilder.buildCheckpointGlobalVariables.mock.calls[0][3]?.pendingCheckpointState?.feeHeader,
      ).toEqual(childFeeHeader);
    });

    it('surfaces the L1 failure', async () => {
      setFrontier();
      globalVariableBuilder.buildCheckpointGlobalVariables.mockRejectedValue(new Error('L1 is down'));

      await expect(cache.getCheckpointOpeningGasFees(SlotNumber(20), parentOf(BlockNumber(5)))).rejects.toThrow(
        'L1 is down',
      );
    });
  });

  describe('readers other than the validator', () => {
    let predictor: NextBlockPredictor;

    beforeEach(() => {
      priceBySyncPoint();
      predictor = new NextBlockPredictor({ feeCache: cache });
    });

    it('tags a quote with the L1 block its record was priced at, one block behind the frontier', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      await cache.refresh();
      setFrontier({ l1SyncPoint: syncPoint(2) });

      const quote = await predictor.quoteMinFees();

      expect(quote).toEqual({ fees: new GasFees(0, 20_001), l1SyncPoint: syncPoint(1) });
    });

    it('re-plans a simulation whose frontier moves while it waits for the boundary fee', async () => {
      setFrontier({ l1SyncPoint: syncPoint(1) });
      const firstPricing = gateNextPricing();

      const prediction = predictor.predict();
      await firstPricing.started;
      const moved = setFrontier({
        checkpointed: CheckpointNumber(2),
        checkpointedBlock: BlockNumber(6),
        proposed: BlockNumber(6),
        l1SyncPoint: syncPoint(2),
      });
      firstPricing.release();

      const { frontier, globals } = await prediction;
      expect(frontier).toBe(moved);
      expect(globals.gasFees).toEqual(new GasFees(0, 20_002));
    });

    it.each([
      ['at the same height on another fork', { blockNumber: 1n, blockHash: Buffer32.fromField(new Fr(99)) }],
      ['above the frontier', syncPoint(3)],
    ])('re-prices rather than serve a record priced %s', async (_name, pricedAt) => {
      setFrontier({ l1SyncPoint: pricedAt });
      await cache.refresh();
      setFrontier({ l1SyncPoint: syncPoint(1) });

      await expect(predictor.quoteMinFees()).resolves.toEqual({
        fees: new GasFees(0, 20_001),
        l1SyncPoint: syncPoint(1),
      });
    });
  });

  it('has nothing to price mid-checkpoint', async () => {
    blockSource.getL2Frontier.mockResolvedValue(
      makeFrontier({
        proposed: BlockNumber(9),
        checkpointedBlock: BlockNumber(3),
        checkpointed: CheckpointNumber(1),
        latestBlockGlobals: { slotNumber: SlotNumber(42) },
      }),
    );

    await cache.refresh();

    expect(globalVariableBuilder.buildCheckpointGlobalVariables).not.toHaveBeenCalled();
    expect(rollupContract.getCheckpointAndManaTarget).not.toHaveBeenCalled();
  });
});
