import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import {
  type RollupContract,
  SimulationOverridesBuilder,
  type SimulationOverridesPlan,
} from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber, type SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/promise';
import { Timer, executeTimeout } from '@aztec-labs/foundation/timer';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import {
  type L1SyncPoint,
  type L2BlockId,
  type L2BlockSource,
  L2BlockSourceEvents,
  type L2Frontier,
  getBlockSourceEmitter,
} from '@aztec-labs/stdlib/block';
import { buildCheckpointSimulationOverridesPlan } from '@aztec-labs/stdlib/checkpoint';
import type { GasFees } from '@aztec-labs/stdlib/gas';
import type { CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';
import type { CheckpointGlobalVariables, GlobalVariableBuilder } from '@aztec-labs/stdlib/tx';
import type { CheckpointOpeningFeeSource } from '@aztec-labs/validator-client';

import {
  type BoundaryFeeKey,
  type NewCheckpointPlan,
  type NextBlockPlan,
  boundaryFeeKeyEquals,
  computeBoundaryFeeKey,
  getClockSlot,
  planNextBlock,
} from './next_block_planner.js';

/** Default interval for the background refresh, well below L1's block time. */
export const DEFAULT_REFRESH_INTERVAL_MS = 1000;

/** Refreshes a reader waits through on a miss, re-planning from a new snapshot after each, before giving up. */
const MAX_READER_REFRESHES = 2;

/**
 * Refreshes one pass of the background loop runs at most. The first may be one a reader started for another slot or
 * an older snapshot; the second prices the boundary the loop itself plans.
 */
const MAX_REFRESHES_PER_PASS = 2;

/** A priced checkpoint boundary, with the L1 block it was priced at. */
export type BoundaryFeeRecord = {
  key: BoundaryFeeKey;
  l1SyncPoint: L1SyncPoint | undefined;
  globals: CheckpointGlobalVariables;
};

/** The next block as a reader planned it, with the priced boundary when it opens a checkpoint and one was served. */
export type NextBlockLookup = {
  /** Snapshot the plan was derived from. */
  frontier: L2Frontier;
  plan: NextBlockPlan;
  /** Set when the next block opens a checkpoint, so its fee comes from L1 rather than from the proposed tip. */
  key?: BoundaryFeeKey;
  /** The record the reader is served, when the cache has one it may use. */
  record?: BoundaryFeeRecord;
};

/** Dependencies required to build a {@link NextBlockFeeCache}. */
export interface NextBlockFeeCacheDeps {
  blockSource: L2BlockSource;
  globalVariableBuilder: GlobalVariableBuilder;
  /**
   * Rollup contract used to build the fee-relevant L1 state overrides when opening a new checkpoint.
   * Only needed when a proposed parent checkpoint exists (pipelining) or the pending chain is invalid;
   * may be omitted in environments that never reach those states (e.g. TXE). When omitted, those paths
   * degrade to a pinned-tips plan (non-pipelined fees) instead.
   */
  rollupContract?: RollupContract;
  epochCache: EpochCacheInterface;
  signatureContext: CoordinationSignatureContext;
  log?: Logger;
}

/**
 * Caches the checkpoint globals, and so the mana min fee, that a block opening a fresh checkpoint would carry.
 * This is the only value on the RPC path that has to be read from L1.
 *
 * The cache holds one record: the boundary priced from the archiver's latest snapshot, keyed by {@link BoundaryFeeKey}
 * (the target slot, the checkpointed tip, the block the plan builds on, and the proposed parent's fee-relevant fields
 * or the pending chain's validity) and stamped with the L1 block it was priced at. Every read of a re-price is pinned
 * to that block's hash, so the fee describes exactly that block. A background loop re-prices whenever the key or the
 * archiver's L1 sync point moves, and is woken early when the archiver announces a new sync point, so a fee oracle or
 * governance update that does not move the key is picked up on the next L1 block.
 *
 * Readers plan the next block from a fresh snapshot and look the record up. On a miss they do not call L1
 * themselves: they join the single refresh in flight, or start the one the loop would have started, then re-plan from
 * a new snapshot, since the chain may have moved while they waited. A validator checking a proposal needs a record
 * priced at its own snapshot's L1 block. Simulations, quotes and admission also take a record one L1 block behind
 * their snapshot, so they do not miss every time L1 produces a block. Simulations wait for as long as the refresh
 * takes and surface its failure; quotes cap their wait; admission never waits.
 *
 * Before {@link start} (or after {@link stop}) readers still price inline through the same refresh path, which is
 * what tests and TXE-like environments rely on.
 */
export class NextBlockFeeCache implements CheckpointOpeningFeeSource {
  private readonly blockSource: L2BlockSource;
  private readonly globalVariableBuilder: GlobalVariableBuilder;
  private readonly rollupContract: RollupContract | undefined;
  private readonly epochCache: EpochCacheInterface;
  private readonly signatureContext: CoordinationSignatureContext;
  private readonly log: Logger;

  private record: BoundaryFeeRecord | undefined;
  private refreshLoop: RunningPromise | undefined;
  private inFlightRefresh: Promise<void> | undefined;

  constructor(deps: NextBlockFeeCacheDeps) {
    this.blockSource = deps.blockSource;
    this.globalVariableBuilder = deps.globalVariableBuilder;
    this.rollupContract = deps.rollupContract;
    this.epochCache = deps.epochCache;
    this.signatureContext = deps.signatureContext;
    this.log = deps.log ?? createLogger('node:next-block-fee-cache');
  }

  /**
   * Starts the background refresh. The loop's first pass begins immediately and a request that arrives before it
   * completes joins it rather than pricing on its own, so nothing waits on priming here: a node whose archiver or
   * L1 client is not ready yet still starts, and the loop fills the cache once they are. A second call while
   * running is a no-op, so it cannot orphan a loop that {@link stop} could then never reach.
   */
  public start(pollingIntervalMs = DEFAULT_REFRESH_INTERVAL_MS): void {
    if (this.refreshLoop) {
      return;
    }
    this.refreshLoop = new RunningPromise(() => this.runLoopPass(), this.log, pollingIntervalMs).start();
    getBlockSourceEmitter(this.blockSource)?.on(L2BlockSourceEvents.L1SyncPointUpdated, this.onSyncPointUpdated);
  }

  public async stop(): Promise<void> {
    getBlockSourceEmitter(this.blockSource)?.off(L2BlockSourceEvents.L1SyncPointUpdated, this.onSyncPointUpdated);
    const loop = this.refreshLoop;
    this.refreshLoop = undefined;
    await loop?.stop();
    // A refresh started by a request rather than by the loop may still be running; let it drain.
    await this.inFlightRefresh?.catch(() => {});
  }

  /**
   * Plans the next block from a fresh snapshot and, when it opens a checkpoint, finds its priced boundary. On a miss
   * it joins the shared refresh and re-plans, for at most {@link MAX_READER_REFRESHES} refreshes. Without `maxWaitMs`
   * it waits for each refresh and surfaces its failure; with it, it gives up waiting once that budget is spent, and
   * with a budget of zero it only starts the refresh. The result carries no record when none could be served.
   */
  public async lookupNextBlock(maxWaitMs?: number): Promise<NextBlockLookup> {
    const timer = new Timer();
    for (let refreshes = 0; ; refreshes++) {
      const frontier = await this.blockSource.getL2Frontier();
      const plan = planNextBlock(frontier, getClockSlot(this.epochCache));
      const key = computeBoundaryFeeKey(plan, frontier.pendingChainValidationStatus);
      if (!key) {
        return { frontier, plan };
      }
      const record = this.findRecord(key, frontier.l1SyncPoint, { allowOneBlockBehind: true });
      if (record || refreshes === MAX_READER_REFRESHES) {
        return { frontier, plan, key, record };
      }

      const refresh = this.refresh();
      if (maxWaitMs === undefined) {
        await refresh;
        continue;
      }
      const remainingMs = maxWaitMs - timer.ms();
      if (remainingMs <= 0) {
        return { frontier, plan, key };
      }
      await this.waitFor(refresh, remainingMs);
    }
  }

  /**
   * The gas fees the first block of a checkpoint at `slot` built on `parent` must carry, for checking a block proposal
   * against. Keyed on the proposal's slot and parent rather than on the slot this node's clock would plan: the frontier
   * must end at `parent`, and the boundary is planned for `slot` from it. A record priced for that boundary at the
   * frontier's own L1 block is served from memory; on a miss the request joins the refresh in flight, or runs one
   * planned on `slot`, and re-plans from a new snapshot, so it gets the exact price even if the chain moved meanwhile.
   *
   * Undefined when this node's view does not hold the data to produce the price the proposer computes yet: the
   * frontier does not end at `parent` (the parent's checkpoint proposal has not been processed, or the chain moved
   * on), or the checkpointed tip has not reached the parent's parent, whose fee state the pipelined plan reads from
   * L1 (see {@link pricesAsProposer}). The caller waits for a later archiver sync rather than accepting the pinned-tips
   * approximation. Throws when the L1 read fails.
   *
   * Only a record priced at the frontier's own L1 block, compared by hash, is served. The L1 fee oracle can change
   * without moving the frontier (anyone may call its update), so a record from any other block could carry a price
   * the proposer did not compute.
   */
  public async getCheckpointOpeningGasFees(slot: SlotNumber, parent: L2BlockId): Promise<GasFees | undefined> {
    for (let refreshes = 0; ; refreshes++) {
      const frontier = await this.blockSource.getL2Frontier();
      const tip = frontier.tips.proposed;
      if (tip.number !== parent.number || tip.hash !== parent.hash) {
        this.log.debug(`Cannot price the checkpoint opened at slot ${slot}: the proposed tip is not its parent`, {
          slot,
          parent,
          tip,
        });
        return undefined;
      }
      const plan = planNextBlock(frontier, slot);
      const newCheckpoint = plan.newCheckpoint;
      if (!newCheckpoint || newCheckpoint.targetSlot !== slot || !this.pricesAsProposer(frontier, newCheckpoint)) {
        this.log.debug(`Cannot price the checkpoint opened at slot ${slot} as its proposer does from this frontier`, {
          slot,
          parent,
          targetSlot: newCheckpoint?.targetSlot,
          proposedCheckpointNumber: newCheckpoint?.proposedCheckpointData?.checkpointNumber,
          checkpointedCheckpointNumber: newCheckpoint?.checkpointedCheckpointNumber,
        });
        return undefined;
      }
      const key = computeBoundaryFeeKey(plan, frontier.pendingChainValidationStatus);
      if (!key) {
        return undefined;
      }
      const record = this.findRecord(key, frontier.l1SyncPoint, { allowOneBlockBehind: false });
      if (record) {
        return record.globals.gasFees;
      }
      if (refreshes === MAX_READER_REFRESHES) {
        this.log.debug(`Could not price the checkpoint opened at slot ${slot} at this node's L1 sync point`, {
          slot,
          parent,
          l1SyncPoint: frontier.l1SyncPoint,
        });
        return undefined;
      }
      await this.refresh(slot);
    }
  }

  /**
   * Runs one refresh pass, or joins the one already running. Single-flight is what keeps a burst of requests
   * during a transition down to a single L1 round trip, shared with the background loop. A pass plans from the
   * archiver's current snapshot and re-prices only when its key or L1 sync point differs from the record's.
   * @param slot - Slot to plan the boundary for in place of this node's clock slot.
   */
  public refresh(slot?: SlotNumber): Promise<void> {
    if (this.inFlightRefresh) {
      return this.inFlightRefresh;
    }
    const refresh = this.runRefresh(slot).finally(() => {
      this.inFlightRefresh = undefined;
    });
    // Every caller awaits the returned promise and reports its failure, but the stored copy may only be awaited by
    // stop() after it has settled. Mark it handled now so a failure can never surface as an unhandled rejection.
    refresh.catch(() => {});
    this.inFlightRefresh = refresh;
    return refresh;
  }

  private readonly onSyncPointUpdated = () => {
    void this.refreshLoop
      ?.trigger()
      .catch(err => this.log.debug(`Refresh triggered by an L1 sync point update did not run`, { err }));
  };

  /**
   * One pass of the background loop. The refresh it starts may join one a reader started for another slot or from an
   * older snapshot, so it refreshes once more if the record still does not describe the boundary the clock plans at
   * the archiver's current sync point, rather than waiting a whole interval.
   */
  private async runLoopPass(): Promise<void> {
    for (let i = 0; i < MAX_REFRESHES_PER_PASS; i++) {
      await this.refresh();
      const frontier = await this.blockSource.getL2Frontier();
      const plan = planNextBlock(frontier, getClockSlot(this.epochCache));
      const key = computeBoundaryFeeKey(plan, frontier.pendingChainValidationStatus);
      if (!key || this.findRecord(key, frontier.l1SyncPoint, { allowOneBlockBehind: false })) {
        return;
      }
    }
  }

  private async runRefresh(slot?: SlotNumber): Promise<void> {
    const frontier = await this.blockSource.getL2Frontier();
    const plan = planNextBlock(frontier, slot ?? getClockSlot(this.epochCache));
    const key = computeBoundaryFeeKey(plan, frontier.pendingChainValidationStatus);
    if (!key || !plan.newCheckpoint) {
      // Mid-checkpoint: the fee is frozen in the in-progress checkpoint's header, so there is nothing to price.
      return;
    }
    if (this.findRecord(key, frontier.l1SyncPoint, { allowOneBlockBehind: false })) {
      return;
    }

    const overrides = await this.buildOverridesPlan(frontier, plan.newCheckpoint);
    // Pinned to the L1 block the frontier was read at, so the fee describes the same L1 state the plan derives
    // from. Unpinned before the archiver's first sync pass, where the read falls back to L1's head.
    const l1SyncPoint = frontier.l1SyncPoint;
    const globals = await this.globalVariableBuilder.buildCheckpointGlobalVariables(
      EthAddress.ZERO,
      AztecAddress.ZERO,
      plan.newCheckpoint.targetSlot,
      overrides,
      { blockNumber: l1SyncPoint?.blockNumber, blockHash: l1SyncPoint?.blockHash.toString() },
    );
    this.record = { key, l1SyncPoint, globals };
  }

  /**
   * The record, if it prices the boundary keyed by `key` and may be served to a reader whose snapshot is anchored at
   * `l1SyncPoint`: priced at that very block, compared by hash, or, when `allowOneBlockBehind` is set, at the block
   * just below it. The one-block-behind record's ancestry is not checked, so after a one-block L1 reorg that changed
   * only the fee oracle it can serve the dropped fork's fee for one block; only non-consensus readers accept that.
   */
  private findRecord(
    key: BoundaryFeeKey,
    l1SyncPoint: L1SyncPoint | undefined,
    { allowOneBlockBehind }: { allowOneBlockBehind: boolean },
  ): BoundaryFeeRecord | undefined {
    const record = this.record;
    if (record === undefined || !boundaryFeeKeyEquals(record.key, key)) {
      return undefined;
    }
    const pricedAt = record.l1SyncPoint;
    if (pricedAt === undefined || l1SyncPoint === undefined) {
      return pricedAt === l1SyncPoint ? record : undefined;
    }
    if (pricedAt.blockHash.equals(l1SyncPoint.blockHash)) {
      return record;
    }
    return allowOneBlockBehind && pricedAt.blockNumber + 1n === l1SyncPoint.blockNumber ? record : undefined;
  }

  /** Awaits `promise` for at most `maxWaitMs`, swallowing both a timeout and the promise's own failure. */
  private waitFor(promise: Promise<void>, maxWaitMs: number): Promise<void> {
    return executeTimeout(() => promise, maxWaitMs).catch(err =>
      this.log.debug(`Refreshing the next-block boundary fee failed or timed out`, err),
    );
  }

  /**
   * Whether {@link buildOverridesPlan} prices `newCheckpoint` with the plan its proposer uses, rather than with the
   * pinned-tips fallback. The sequencer never builds on a proposed parent more than one checkpoint ahead of its
   * checkpointed tip, so a frontier in that state trails L1: the parent's parent, whose fee header the pipelined plan
   * reads, is not checkpointed in it yet, and the fallback price is not one a proposer would have used.
   */
  private pricesAsProposer(frontier: L2Frontier, newCheckpoint: NewCheckpointPlan): boolean {
    const { proposedCheckpointData, checkpointedCheckpointNumber } = newCheckpoint;
    if (proposedCheckpointData) {
      return (
        this.rollupContract !== undefined &&
        proposedCheckpointData.checkpointNumber === checkpointedCheckpointNumber + 1
      );
    }
    // On a valid chain with no proposed parent the pinned-tips plan is the one the proposer builds.
    return this.rollupContract !== undefined || frontier.pendingChainValidationStatus.valid;
  }

  /**
   * Builds the chain-state overrides plan passed to `buildCheckpointGlobalVariables`, mirroring the sequencer
   * (which always pins tips to neutralize prunes). When pipelining, the plan carries the proposed parent's
   * archive, temp-checkpoint-log cell, and locally-derived fee header; when the pending chain is invalid, it
   * pins the tips to the last valid checkpoint instead.
   *
   * Both of those need a rollup contract for the L1 fee reads. Environments that omit it (e.g. TXE, which never
   * has a proposed checkpoint and whose pending chain is always valid) fall back to pinning both pending and
   * proven tips to the checkpointed tip, which neutralizes prunes in fee computation at the cost of
   * non-pipelined fees.
   */
  private buildOverridesPlan(
    frontier: L2Frontier,
    newCheckpoint: NewCheckpointPlan,
  ): Promise<SimulationOverridesPlan | undefined> {
    const { targetCheckpoint, proposedCheckpointData, checkpointedCheckpointNumber } = newCheckpoint;
    const rollup = this.rollupContract;
    const pinnedTips = () =>
      Promise.resolve(
        new SimulationOverridesBuilder()
          .withChainTips({ pending: checkpointedCheckpointNumber, proven: checkpointedCheckpointNumber })
          .build(),
      );
    if (!rollup) {
      return pinnedTips();
    }

    // A pipelined plan derives the proposed parent's fee header from the grandparent's on-chain `tempCheckpointLogs`
    // cell, so it can only be built while the parent is the checkpointed tip's immediate child. The frontier runs
    // further ahead whenever a proposer builds on a checkpoint whose publication has not been mined yet, which every
    // node then sees through gossip, and L1 keeps no cell for a checkpoint it has not seen: the read reverts with
    // `Rollup__UnavailableTempCheckpointLog` and takes the whole refresh, and every simulation joined to it, down.
    // Price that boundary on the checkpointed tip instead. The fee then lags by the checkpoints in flight (two at
    // this depth, one more than the fee projections cover), rather than being unavailable for the rest of the window.
    // Quoting a fee that may be off is deliberate: the quote feeds simulation, and a simulation that runs on an
    // approximate fee is more useful than one that fails because the exact fee cannot be derived yet.
    if (proposedCheckpointData && proposedCheckpointData.checkpointNumber !== checkpointedCheckpointNumber + 1) {
      this.log.debug(
        `Pricing the next-block boundary on checkpointed tip ${checkpointedCheckpointNumber}: proposed parent ` +
          `${proposedCheckpointData.checkpointNumber} is more than one checkpoint ahead of it`,
      );
      return pinnedTips();
    }

    // The plan's L1 reads are pinned to the archiver's sync point, which only exists once the archiver has run a
    // sync pass. Until then there is no L1 block to read the parent's fee header at, so price on the checkpointed tip,
    // as the fee simulation itself falls back to L1's head.
    const l1SyncPoint = frontier.l1SyncPoint;
    if (l1SyncPoint === undefined) {
      this.log.debug(
        `Pricing the next-block boundary on checkpointed tip ${checkpointedCheckpointNumber}: no L1 sync point yet`,
      );
      return pinnedTips();
    }

    // The helper treats pipelining and invalidation as mutually exclusive; a proposed parent takes precedence.
    const validationStatus = frontier.pendingChainValidationStatus;
    const invalidateToPendingCheckpointNumber =
      !proposedCheckpointData && !validationStatus.valid
        ? CheckpointNumber(validationStatus.checkpoint.checkpointNumber - 1)
        : undefined;
    return buildCheckpointSimulationOverridesPlan({
      checkpointNumber: targetCheckpoint,
      proposedCheckpointData,
      invalidateToPendingCheckpointNumber,
      checkpointedCheckpointNumber,
      rollup,
      // The same L1 block the fee simulation is pinned to, so the parent's fee header and the fee agree.
      l1BlockNumber: l1SyncPoint.blockNumber,
      l1BlockHash: l1SyncPoint.blockHash.toString(),
      signatureContext: this.signatureContext,
      log: this.log,
    });
  }
}
