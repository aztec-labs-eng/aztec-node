import {
  type CheckpointLog,
  RollupContract,
  type RollupRead,
  type RollupReadOutcomes,
  getReadValue,
  rollupReads,
} from '@aztec-labs/ethereum/contracts';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import { maxBigint } from '@aztec-labs/foundation/bigint';
import { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { compactArray, times, uniqueBy } from '@aztec-labs/foundation/collection';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import { type DateProvider, Timer } from '@aztec-labs/foundation/timer';
import {
  type ArchiverEmitter,
  type L1SyncPoint,
  type L2BlockSource,
  L2BlockSourceEvents,
} from '@aztec-labs/stdlib/block';
import { getNextL1SlotTimestamp, getSlotAtNextL1Block, getTimestampForSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { FEE_ORACLE_LAG, GasFees, ManaUsageEstimate, computeExcessMana } from '@aztec-labs/stdlib/gas';
import type { FeeAsOf, FeeProvider } from '@aztec-labs/stdlib/tx';

import { type FeeOracleState, computeFeePredictions } from './fee_predictor.js';
import type { GlobalVariableBuilderConfig } from './global_builder.js';

/** Default interval for the background refresh loop, well below L1's block time. */
const DEFAULT_REFRESH_POLLING_INTERVAL_MS = 1000;

/**
 * Refresh passes a tagged request waits through before settling for the provider's current view. The first pass it
 * joins may have started from an older sync point than the one it is tagged with; the second is its own.
 */
const MAX_REFRESH_ATTEMPTS = 2;

/**
 * Refreshes one pass of the background loop runs at most. The first may be one a request started for an older sync
 * point; the second catches up with the sync point the loop was woken for.
 */
const MAX_REFRESHES_PER_PASS = 2;

/**
 * L1 requests one refresh may send. The reads depend on each other three deep: the tips, then the checkpoints they
 * name and whether the chain can prune, then the fee oracle at the slots those checkpoints imply.
 */
const MAX_READ_ROUNDS = 3;

/** Fees as read at one L1 block. Every read that produced it was pinned to `blockHash`. */
type FeeEntry = L1SyncPoint & {
  currentMinFees: GasFees;
  predictorState: FeeOracleState;
  /** The rollup's chain tips at that block, which the next refresh guesses its checkpoint reads from. */
  tips: { pending: CheckpointNumber; proven: CheckpointNumber };
};

/** The node clock a refresh derives its slots and timestamps from, read once per refresh. */
type FeeClock = {
  /** Timestamp of the next L1 block, the earliest a transaction priced now can land. */
  nextEthTimestamp: bigint;
  /** The L2 slot of the next L1 block. */
  clockSlot: SlotNumber;
};

/** Where the provider learns the archiver's L1 sync point, and the events that announce it moved, if any. */
export type FeeSyncPointSource = Pick<L2BlockSource, 'getL1SyncPoint'> & { events?: ArchiverEmitter };

/**
 * Provides current and predicted fee information based on on-chain state, refreshed from the archiver's L1 sync
 * point rather than from a poll of its own.
 *
 * Following the archiver means the fees and the block plans that consume them describe the same L1 block: two
 * independent L1 pollers would otherwise disagree for up to a poll interval after a checkpoint lands, and the
 * mana min fee is a step function of the slot, so that disagreement shows up as a wallet quote the node's own
 * public simulation then rejects.
 *
 * A refresh reads everything it needs pinned to the sync point's block hash, batched into one Multicall3 call. The
 * batch guesses the arguments that depend on other reads (the checkpoints the tips name, the slots the fees are
 * projected at) from the previous entry and the clock, so a quiet L1 block, a slot rollover or a checkpoint landing
 * costs one request; a guess that misses costs one more request for the reads whose arguments are then known. Every
 * value stored was read with the arguments the fee formulas dictate, so a guess only ever affects the request count.
 *
 * The background loop polls the sync point every interval and is woken early when the archiver announces a new one,
 * so the provider follows the archiver without waiting out a poll.
 */
export class FeeProviderImpl implements FeeProvider {
  private entry: FeeEntry | undefined;
  private refreshLoop: RunningPromise | undefined;
  private inFlightRefresh: Promise<void> | undefined;

  private readonly rollupContract: RollupContract;
  private readonly slotDuration: number;
  private readonly ethereumSlotDuration: number;
  private readonly l1GenesisTime: bigint;
  private readonly log: Logger = createLogger('sequencer-client:fee-provider');

  constructor(
    private readonly dateProvider: DateProvider,
    private readonly publicClient: ViemPublicClient,
    config: GlobalVariableBuilderConfig,
    private readonly syncPointSource: FeeSyncPointSource,
  ) {
    this.slotDuration = config.slotDuration;
    this.ethereumSlotDuration = config.ethereumSlotDuration;
    this.l1GenesisTime = config.l1GenesisTime;
    this.rollupContract = new RollupContract(this.publicClient, config.rollupAddress);
  }

  public async start(pollingIntervalMs = DEFAULT_REFRESH_POLLING_INTERVAL_MS): Promise<void> {
    await this.refresh();
    this.refreshLoop = new RunningPromise(() => this.runLoopPass(), this.log, pollingIntervalMs);
    this.refreshLoop.start();
    this.syncPointSource.events?.on(L2BlockSourceEvents.L1SyncPointUpdated, this.onSyncPointUpdated);
  }

  public async stop(): Promise<void> {
    this.syncPointSource.events?.off(L2BlockSourceEvents.L1SyncPointUpdated, this.onSyncPointUpdated);
    await this.refreshLoop?.stop();
    await this.inFlightRefresh?.catch(() => {});
  }

  /**
   * Refreshes the fee entry against the archiver's current L1 sync point, unless the entry already describes it.
   * Single-flight: a call made while a refresh is running joins that refresh instead of starting a second one, so
   * the loop and any waiting requests share one round of L1 reads.
   */
  public refresh(): Promise<void> {
    return (this.inFlightRefresh ??= this.doRefresh().finally(() => {
      this.inFlightRefresh = undefined;
    }));
  }

  public async getCurrentMinFees(asOf?: FeeAsOf): Promise<GasFees> {
    const entry = await this.getEntry(asOf);
    return entry?.currentMinFees ?? new GasFees(0, 0);
  }

  public async getPredictedMinFees(manaUsage?: ManaUsageEstimate, asOf?: FeeAsOf): Promise<GasFees[]> {
    const entry = await this.getEntry(asOf);
    if (entry === undefined) {
      throw new Error('FeeProviderImpl.start() must be called before getPredictedMinFees()');
    }
    const predictions = computeFeePredictions(entry.predictorState, manaUsage ?? ManaUsageEstimate.Target);
    return [entry.currentMinFees, ...predictions];
  }

  private readonly onSyncPointUpdated = () => {
    void this.refreshLoop
      ?.trigger()
      .catch(err => this.log.debug(`Refresh triggered by an L1 sync point update did not run`, { err }));
  };

  /**
   * One pass of the background loop. The refresh it starts may join one a request started for an older sync point,
   * so it refreshes once more if the entry still trails the sync point afterwards, rather than waiting a whole interval.
   */
  private async runLoopPass(): Promise<void> {
    for (let i = 0; i < MAX_REFRESHES_PER_PASS; i++) {
      await this.refresh();
      const syncPoint = await this.syncPointSource.getL1SyncPoint();
      if (syncPoint === undefined || this.entry?.blockHash.equals(syncPoint.blockHash)) {
        return;
      }
    }
  }

  /**
   * Picks the entry to serve. A tagged request whose L1 block the entry does not describe waits for the shared
   * refresh, and once more for its own if the one it joined was already under way from an older sync point, all
   * within `maxWaitMs` when set, and then gets the entry whatever block it describes. A request tagged with a block
   * the provider has already moved past is answered at once from the entry, without joining a refresh. A tagged miss
   * never throws: the caller asked for a specific L1 view as a consistency preference, not as a precondition.
   */
  private async getEntry(asOf?: FeeAsOf): Promise<FeeEntry | undefined> {
    if (asOf === undefined) {
      return this.entry;
    }

    const timer = new Timer();
    for (let attempt = 0; attempt < MAX_REFRESH_ATTEMPTS; attempt++) {
      if (this.entry && (this.entry.blockHash.equals(asOf.blockHash) || this.entry.blockNumber > asOf.blockNumber)) {
        return this.entry;
      }
      const remainingMs = asOf.maxWaitMs === undefined ? undefined : asOf.maxWaitMs - timer.ms();
      if (remainingMs !== undefined && remainingMs <= 0) {
        break;
      }
      await this.awaitRefresh(remainingMs);
    }

    if (!this.entry?.blockHash.equals(asOf.blockHash)) {
      this.log.debug(`Serving fees for another L1 block than the one requested`, {
        requestedBlockNumber: asOf.blockNumber,
        requestedBlockHash: asOf.blockHash.toString(),
        servedBlockNumber: this.entry?.blockNumber,
      });
    }
    return this.entry;
  }

  /** Waits for the shared refresh, giving up after `maxWaitMs` if set. Never rejects. */
  private async awaitRefresh(maxWaitMs: number | undefined): Promise<void> {
    const refresh = this.refresh().catch(err =>
      this.log.warn(`Failed to refresh fees while serving a request`, { err }),
    );
    if (maxWaitMs === undefined) {
      return refresh;
    }

    const cap = promiseWithResolvers<void>();
    const timer = setTimeout(cap.resolve, maxWaitMs);
    await Promise.race([refresh, cap.promise]).finally(() => clearTimeout(timer));
  }

  private async doRefresh(): Promise<void> {
    const syncPoint = await this.resolveSyncPoint();
    if (this.entry?.blockHash.equals(syncPoint.blockHash)) {
      return;
    }
    this.entry = await this.readEntry(syncPoint);
  }

  /**
   * The L1 block to price at: the archiver's sync point once it has run a pass, otherwise L1's head. The
   * fallback only applies before the archiver's first pass, so a node can answer fee queries while it is still
   * catching up rather than blocking startup on the archiver.
   */
  private async resolveSyncPoint(): Promise<L1SyncPoint> {
    const syncPoint = await this.syncPointSource.getL1SyncPoint();
    if (syncPoint !== undefined) {
      return syncPoint;
    }
    const block = await this.publicClient.getBlock({ blockTag: 'latest' });
    return { blockNumber: block.number, blockHash: Buffer32.fromString(block.hash) };
  }

  /**
   * Reads the fee state at `syncPoint`: one batch of reads, the first with guessed arguments, then batches of the
   * reads the derivation still lacks, until it completes.
   */
  private async readEntry(syncPoint: L1SyncPoint): Promise<FeeEntry> {
    const clock = this.readClock();
    const epochDuration = BigInt(await this.rollupContract.getEpochDuration());
    const outcomes: RollupReadOutcomes = new Map();
    let reads = this.guessReads(clock);
    for (let round = 1; round <= MAX_READ_ROUNDS; round++) {
      const batch = await this.rollupContract.readBatch(
        uniqueBy(reads, read => read.key),
        syncPoint.blockHash.toString(),
      );
      for (const [key, outcome] of batch) {
        outcomes.set(key, outcome);
      }
      const derived = this.derive(outcomes, clock, epochDuration);
      if ('entry' in derived) {
        this.log.trace(`Read fees at L1 block ${syncPoint.blockNumber}`, { ...syncPoint, rounds: round });
        return { ...syncPoint, ...derived.entry };
      }
      if (derived.missing.length === 0) {
        throw new Error(`Fee state at L1 block ${syncPoint.blockNumber} is incomplete with no reads left to make`);
      }
      reads = derived.missing;
    }
    throw new Error(`Could not read the fee state at L1 block ${syncPoint.blockNumber} in ${MAX_READ_ROUNDS} requests`);
  }

  private readClock(): FeeClock {
    const now = this.dateProvider.nowInSeconds();
    return {
      nextEthTimestamp: getNextL1SlotTimestamp(now, {
        l1GenesisTime: this.l1GenesisTime,
        ethereumSlotDuration: this.ethereumSlotDuration,
      }),
      clockSlot: getSlotAtNextL1Block(BigInt(now), {
        l1GenesisTime: this.l1GenesisTime,
        slotDuration: this.slotDuration,
        ethereumSlotDuration: this.ethereumSlotDuration,
      }),
    };
  }

  private timestampForSlot(slot: SlotNumber): bigint {
    return getTimestampForSlot(slot, { slotDuration: this.slotDuration, l1GenesisTime: this.l1GenesisTime });
  }

  /**
   * The first batch of a refresh: every read whose arguments are known up front, plus guesses for the rest. The
   * checkpoint guesses assume the tips are the previous entry's or one checkpoint ahead, and the slot guesses assume
   * the next checkpoint lands at the clock's slot or the one after.
   */
  private guessReads({ nextEthTimestamp, clockSlot }: FeeClock): RollupRead<unknown>[] {
    const tips = this.entry?.tips;
    const slotAfterClock = (offset: number) => this.timestampForSlot(SlotNumber.add(clockSlot, offset));
    return [
      rollupReads.tips(),
      rollupReads.currentSlot(),
      rollupReads.manaTarget(),
      rollupReads.provingCostPerManaInEth(),
      rollupReads.protocolFeeMargin(),
      ...(tips === undefined
        ? []
        : [
            rollupReads.checkpoint(tips.pending),
            rollupReads.checkpoint(CheckpointNumber.add(tips.pending, 1)),
            rollupReads.checkpoint(tips.proven),
          ]),
      rollupReads.canPruneAtTime(slotAfterClock(0)),
      rollupReads.manaMinFeeAt(nextEthTimestamp),
      rollupReads.manaMinFeeAt(slotAfterClock(1)),
      ...times(FEE_ORACLE_LAG + 1, i => rollupReads.l1FeesAt(slotAfterClock(i))),
    ];
  }

  /**
   * Derives the entry from the reads made so far, with the same formulas as a sequence of individual reads would
   * use. Returns the reads it still lacks when it cannot complete. A read the derivation needs that reverted fails
   * the refresh; a guess it ends up not needing is ignored, whatever its outcome.
   */
  private derive(
    outcomes: RollupReadOutcomes,
    clock: FeeClock,
    epochDuration: bigint,
  ): { entry: Omit<FeeEntry, keyof L1SyncPoint> } | { missing: RollupRead<unknown>[] } {
    const missing: RollupRead<unknown>[] = [];
    /** A read the derivation needs: its value, or undefined after recording it as missing. */
    const need = <T>(read: RollupRead<T>): T | undefined => {
      const value = getReadValue(outcomes, read);
      if (value === undefined) {
        missing.push(read);
      }
      return value;
    };
    /** A read the derivation may need: requested alongside the missing ones, but its failure is not fatal yet. */
    const want = <T>(read: RollupRead<T>): T | undefined => {
      try {
        return need(read);
      } catch {
        return undefined;
      }
    };

    const tips = need(rollupReads.tips());
    const currentSlot = need(rollupReads.currentSlot());
    const manaTarget = need(rollupReads.manaTarget());
    const provingCostPerManaEth = need(rollupReads.provingCostPerManaInEth());
    const protocolFeeMarginBps = need(rollupReads.protocolFeeMargin());
    if (tips === undefined || currentSlot === undefined) {
      return { missing };
    }

    // The current fee: the next block lands no earlier than the slot after the pending checkpoint's, nor before the
    // next L1 block.
    const pendingCheckpoint = need(rollupReads.checkpoint(tips.pending));
    const currentMinFee =
      pendingCheckpoint &&
      need(
        rollupReads.manaMinFeeAt(
          maxBigint(this.timestampForSlot(SlotNumber.add(pendingCheckpoint.slotNumber, 1)), clock.nextEthTimestamp),
        ),
      );

    // The projections start from the checkpoint L1 builds on at the first slot they cover, which is the proven one
    // when the pending chain can be pruned by then. Until that is known both checkpoints are requested, so finding it
    // out never costs a request of its own.
    const firstSlot = SlotNumber(Math.max(currentSlot, clock.clockSlot));
    const canPrune = need(rollupReads.canPruneAtTime(this.timestampForSlot(firstSlot)));
    let lastCheckpoint: CheckpointLog | undefined;
    if (canPrune === undefined) {
      want(rollupReads.checkpoint(tips.proven));
    } else {
      lastCheckpoint = canPrune ? need(rollupReads.checkpoint(tips.proven)) : pendingCheckpoint;
    }
    const nextSlot = lastCheckpoint && SlotNumber(Math.max(SlotNumber.add(lastCheckpoint.slotNumber, 1), firstSlot));
    const l1FeesBySlot =
      nextSlot === undefined
        ? undefined
        : compactArray(
            times(FEE_ORACLE_LAG, i => need(rollupReads.l1FeesAt(this.timestampForSlot(SlotNumber.add(nextSlot, i))))),
          );

    if (
      missing.length > 0 ||
      manaTarget === undefined ||
      provingCostPerManaEth === undefined ||
      protocolFeeMarginBps === undefined ||
      currentMinFee === undefined ||
      lastCheckpoint === undefined ||
      l1FeesBySlot === undefined
    ) {
      return { missing };
    }

    const { feeHeader } = lastCheckpoint;
    return {
      entry: {
        tips,
        currentMinFees: new GasFees(0, currentMinFee),
        predictorState: {
          lastSlot: lastCheckpoint.slotNumber,
          excessMana: computeExcessMana(feeHeader.excessMana, feeHeader.manaUsed, manaTarget),
          ethPerFeeAsset: feeHeader.ethPerFeeAsset,
          manaTarget,
          manaLimit: 2n * manaTarget,
          provingCostPerManaEth,
          epochDuration,
          protocolFeeMarginBps,
          l1FeesBySlot,
        },
      },
    };
  }
}
