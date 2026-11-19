import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { RunningPromise } from '@aztec-labs/foundation/running-promise';
import type { ChonkCache } from '@aztec-labs/prover-client/orchestrator';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';

import type { CheckpointStore } from './checkpoint-store.js';

/** What the sweep reads the chain position from, and what it clears for an expired epoch. */
export type EpochExpirySweepDeps = {
  l2BlockSource: Pick<L2BlockSource, 'getSyncedL2SlotNumber' | 'getL1Constants' | 'getBlocks'>;
  checkpointStore: Pick<CheckpointStore, 'reapExpired'>;
  chonkCache: Pick<ChonkCache, 'releaseForBlocks'>;
  /** Interval between sweeps. */
  intervalMs: number;
  bindings?: LoggerBindings;
};

/**
 * Drops the proving state of epochs whose proof-submission window has closed. An epoch `E` is expired once the chain
 * reaches the start of epoch `E + proofSubmissionEpochs + 1`: L1 no longer accepts a proof of it. For each newly
 * expired epoch the sweep releases the chonk-cache entries of its blocks and removes its provers from the store.
 */
export class EpochExpirySweep {
  private readonly log: Logger;
  /** Highest epoch already expired. Only moves forward, so each epoch is expired once. */
  private lastExpiredEpoch: EpochNumber | undefined;
  private ticker: RunningPromise | undefined;

  constructor(private readonly deps: EpochExpirySweepDeps) {
    this.log = createLogger('prover-node:epoch-expiry-sweep', deps.bindings);
  }

  /**
   * Starts the periodic sweep. Epochs up to and including `lastExpiredEpoch` are treated as already expired.
   * The sweep runs on its own timer, so it also runs while no block-stream events arrive.
   */
  public start(lastExpiredEpoch: EpochNumber | undefined): void {
    this.lastExpiredEpoch = lastExpiredEpoch;
    this.ticker = new RunningPromise(() => this.sweep(), this.log, this.deps.intervalMs);
    this.ticker.start();
  }

  public async stop(): Promise<void> {
    await this.ticker?.stop();
  }

  public getLastExpiredEpoch(): EpochNumber | undefined {
    return this.lastExpiredEpoch;
  }

  /**
   * Expires every epoch whose window closed since the last sweep. Does nothing while the archiver has no synced
   * slot.
   */
  public async sweep(): Promise<void> {
    const latestSlot = await this.deps.l2BlockSource.getSyncedL2SlotNumber();
    if (latestSlot === undefined) {
      return;
    }
    const l1Constants = await this.deps.l2BlockSource.getL1Constants();
    const latestEpoch = getEpochAtSlot(latestSlot, l1Constants);
    const offset = l1Constants.proofSubmissionEpochs + 1;
    if (latestEpoch < offset) {
      return;
    }
    const newlyExpiredUpTo = EpochNumber(latestEpoch - offset);
    const from = this.lastExpiredEpoch === undefined ? EpochNumber(0) : EpochNumber(this.lastExpiredEpoch + 1);
    if (newlyExpiredUpTo < from) {
      return;
    }
    for (let e = from; e <= newlyExpiredUpTo; e = EpochNumber(e + 1)) {
      await this.expireEpoch(e);
    }
    this.lastExpiredEpoch = newlyExpiredUpTo;
  }

  /** Releasing the chonk cache is best-effort: the store is reaped even if the epoch's blocks cannot be read. */
  private async expireEpoch(epoch: EpochNumber): Promise<void> {
    try {
      const blocks = await this.deps.l2BlockSource.getBlocks({ epoch, onlyCheckpointed: true });
      if (blocks.length > 0) {
        this.deps.chonkCache.releaseForBlocks(blocks);
      }
    } catch (err) {
      this.log.warn(`Could not release chonk-cache entries for expired epoch ${epoch}`, { epoch, err });
    }
    this.deps.checkpointStore.reapExpired(epoch);
  }
}
