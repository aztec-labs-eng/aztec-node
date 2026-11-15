import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { unique } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { getLastSiblingPath } from '@aztec-labs/prover-client/helpers';
import {
  EventDrivenL2BlockStream,
  type L2BlockId,
  type L2BlockSource,
  type L2BlockStreamEvent,
  type L2BlockStreamEventHandler,
  L2TipsMemoryStore,
} from '@aztec-labs/stdlib/block';
import type { Checkpoint, CommonCheckpointData, PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import {
  type L1RollupConstants,
  getEpochAtSlot,
  getProofSubmissionDeadlineEpoch,
  getSlotRangeForEpoch,
} from '@aztec-labs/stdlib/epoch-helpers';
import type { WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';

import type { CheckpointStore, RegisterCheckpointData } from './checkpoint-store.js';
import type { EpochProofStatus } from './epoch-proof-status.js';

/**
 * What the follower reports to the rest of the node. The follower awaits the two async handlers before it
 * acknowledges the chain event, so an error thrown by one makes the block stream deliver the event again.
 */
export type CheckpointFollowerHandlers = {
  /** A checkpoint of this epoch is in the store (newly registered, or seen again on a retry). */
  onCheckpointRegistered(epoch: EpochNumber): Promise<void>;
  /** A prune removed provers from the store. Lists each affected epoch once. */
  onPruned(affectedEpochs: EpochNumber[]): Promise<void>;
  /** The proven tip moved. Must not block on L1 work. */
  onChainProven(block: BlockNumber): void;
  /** The proposed tip moved to this block. Must not throw. */
  onChainProposed?(block: BlockNumber): Promise<void>;
  /** The checkpointed tip moved to this block, and every checkpoint up to it has been registered or skipped. */
  onChainCheckpointed?(block: BlockNumber): void;
  /** The chain was pruned back to this block. Called for every prune, whether or not it removed a prover. */
  onChainPruned?(block: BlockNumber): void;
};

/** What the follower reads the chain from, where it registers checkpoints, and whom it reports to. */
export type CheckpointFollowerDeps = {
  l2BlockSource: L2BlockSource;
  l1ToL2MessageSource: L1ToL2MessageSource;
  worldState: Pick<WorldStateSynchronizer, 'syncImmediate' | 'getSnapshot' | 'status'>;
  checkpointStore: Pick<
    CheckpointStore,
    'getByCheckpoint' | 'addOrUpdate' | 'cancelAndRemoveAboveBlock' | 'listForEpoch'
  >;
  proofStatus: Pick<EpochProofStatus, 'isEpochFullyProven' | 'readOwnFullEpochProof' | 'getLastFullyProvenEpoch'>;
  handlers: CheckpointFollowerHandlers;
  config: {
    /** Poll interval of the block stream. */
    pollIntervalMs: number;
    /** A node that never proves full epochs has no use for the checkpoints of an epoch that is already proven. */
    disableFullEpochProving: boolean;
  };
  bindings?: LoggerBindings;
};

/**
 * Follows the chain reported by the archiver and keeps the checkpoint store in step with it.
 *
 * - On a new checkpointed tip it registers every checkpoint between its cursor and the tip, skipping whole epochs
 *   that cannot or need not be proven.
 * - On a prune it removes the provers of orphaned checkpoints and moves the cursor back.
 * - On a new proven tip it notifies the node.
 *
 * Each event is acknowledged (recorded in the tips store) only after its handling succeeded. A handler that throws
 * leaves the tips store behind, so the block stream delivers the same event again on its next poll. Registering a
 * checkpoint and handling a prune are therefore written to be safe to repeat.
 */
export class CheckpointFollower implements L2BlockStreamEventHandler {
  private readonly log: Logger;
  private readonly tipsStore: L2TipsMemoryStore;
  private blockStream: EventDrivenL2BlockStream | undefined;

  /**
   * Highest checkpoint number that has been registered or deliberately skipped. Catch-up walks from here to each
   * checkpointed tip. Moved back on a prune.
   */
  private lastProcessedCheckpoint: CheckpointNumber = CheckpointNumber.ZERO;

  constructor(private readonly deps: CheckpointFollowerDeps) {
    this.log = createLogger('prover-node:checkpoint-follower', deps.bindings);
    this.tipsStore = new L2TipsMemoryStore(deps.l2BlockSource.getGenesisBlockHash());
  }

  /**
   * Places the cursor for a restart and starts following the chain. Returns the epoch the catch-up resumes after
   * (undefined when it starts from the first checkpoint): every epoch up to and including it is left alone.
   */
  public async start(): Promise<EpochNumber | undefined> {
    const resumeAfterEpoch = await this.seedCursor();
    this.blockStream = new EventDrivenL2BlockStream(this.deps.l2BlockSource, this.tipsStore, this, this.log, {
      pollIntervalMS: this.deps.config.pollIntervalMs,
      tipsOnly: true,
    });
    this.blockStream.start();
    return resumeAfterEpoch;
  }

  /** Stops the block stream and waits for the event being handled, if any. */
  public async stop(): Promise<void> {
    await this.blockStream?.stop();
  }

  public getLastProcessedCheckpoint(): CheckpointNumber {
    return this.lastProcessedCheckpoint;
  }

  public async handleBlockStreamEvent(event: L2BlockStreamEvent): Promise<void> {
    switch (event.type) {
      case 'chain-checkpointed':
        await this.catchUpTo(event.checkpoint.number);
        this.deps.handlers.onChainCheckpointed?.(BlockNumber(event.block.number));
        break;
      case 'chain-pruned':
        await this.handlePrune(event.block);
        break;
      case 'chain-proven':
        this.deps.handlers.onChainProven(BlockNumber(event.block.number));
        break;
      case 'chain-proposed':
        await this.deps.handlers.onChainProposed?.(BlockNumber(event.block.number));
        break;
      // `blocks-added` is never emitted in tips-only mode, and `chain-finalized` carries nothing to act on. Both
      // are still recorded in the tips store below.
      case 'chain-finalized':
      case 'blocks-added':
        break;
      default: {
        const _: never = event;
        break;
      }
    }
    await this.tipsStore.handleBlockStreamEvent(event);
  }

  /**
   * Sets the cursor to the last checkpoint of the epoch the catch-up resumes after, and returns that epoch.
   * `start()` calls this before it starts the block stream.
   */
  public async seedCursor(): Promise<EpochNumber | undefined> {
    const lastFullyProvenEpoch = await this.deps.proofStatus.getLastFullyProvenEpoch();
    const resumeAfterEpoch = await this.resolveResumeAfterEpoch(lastFullyProvenEpoch);
    this.lastProcessedCheckpoint = await this.findLastCheckpointThrough(resumeAfterEpoch);
    return resumeAfterEpoch;
  }

  /**
   * The epoch a restart resumes after: the last fully-proven epoch, lowered to the last epoch whose proof-submission
   * window has closed. Epochs between the two are covered by the proven tip but can still be proven, and this prover
   * may hold no full-epoch proof of them.
   */
  private async resolveResumeAfterEpoch(
    lastFullyProvenEpoch: EpochNumber | undefined,
  ): Promise<EpochNumber | undefined> {
    if (lastFullyProvenEpoch === undefined) {
      return undefined;
    }
    const l1Constants = await this.deps.l2BlockSource.getL1Constants();
    const latestSlot = await this.deps.l2BlockSource.getSyncedL2SlotNumber();
    // While the archiver reports no synced slot, assume the earliest possible current epoch: the last fully-proven one.
    // It can still be the current epoch, since the archiver counts an epoch complete once its last slot has a
    // checkpoint. Assuming an earlier epoch only revisits more epochs.
    const currentEpoch = latestSlot === undefined ? lastFullyProvenEpoch : getEpochAtSlot(latestSlot, l1Constants);
    const lastClosedEpoch = currentEpoch - l1Constants.proofSubmissionEpochs - 1;
    if (lastClosedEpoch < 0) {
      return undefined;
    }
    return EpochNumber(Math.min(lastFullyProvenEpoch, lastClosedEpoch));
  }

  /**
   * The last checkpoint at or before the epoch's last slot, or 0 if there is none. The epoch itself may hold no
   * checkpoints, since it is picked by time.
   */
  private async findLastCheckpointThrough(epoch: EpochNumber | undefined): Promise<CheckpointNumber> {
    if (epoch === undefined) {
      return CheckpointNumber.ZERO;
    }
    const [, lastSlot] = getSlotRangeForEpoch(epoch, await this.deps.l2BlockSource.getL1Constants());
    const [last] = await this.deps.l2BlockSource.getCheckpointsData({ fromSlot: lastSlot, limit: 1, reverse: true });
    return last?.checkpointNumber ?? CheckpointNumber.ZERO;
  }

  /**
   * Registers every checkpoint between the cursor and the checkpointed tip. The block stream delivers one tip event
   * per pass, so this walks the gap itself: checkpoint metadata first, to decide per epoch whether to skip it, then
   * the full checkpoint only for epochs it registers.
   *
   * The cursor moves one checkpoint at a time, after that checkpoint was registered or skipped. A failure part-way
   * leaves the cursor before the failed checkpoint, and the next pass retries from there.
   */
  private async catchUpTo(targetCheckpoint: CheckpointNumber): Promise<void> {
    if (targetCheckpoint <= this.lastProcessedCheckpoint) {
      return;
    }
    const l1Constants = await this.deps.l2BlockSource.getL1Constants();

    // A checkpoint older than `(proofSubmissionEpochs + 1) * epochDuration` checkpoints before the tip is past its
    // proof-submission window. After a long time offline the gap can hold thousands of them, so they are not fetched.
    const maxCheckpoints = (l1Constants.proofSubmissionEpochs + 1) * l1Constants.epochDuration;
    let from = CheckpointNumber(this.lastProcessedCheckpoint + 1);
    if (Number(targetCheckpoint - from) + 1 > maxCheckpoints) {
      const cappedFrom = CheckpointNumber(targetCheckpoint - maxCheckpoints + 1);
      this.log.warn(`Skipping unprovable checkpoints during catch-up; the prover node is far behind`, {
        from,
        cappedFrom,
        targetCheckpoint,
        maxCheckpoints,
      });
      this.lastProcessedCheckpoint = CheckpointNumber(cappedFrom - 1);
      from = cappedFrom;
    }
    const limit = Number(targetCheckpoint - from) + 1;
    const metadatas = await this.deps.l2BlockSource.getCheckpointsData({ from, limit });

    // An epoch is skipped as a whole or not at all: a full session needs every checkpoint of its epoch.
    const epochSkippable = new Map<EpochNumber, boolean>();
    for (const metadata of metadatas) {
      const epochNumber = getEpochAtSlot(metadata.header.slotNumber, l1Constants);
      let skippable = epochSkippable.get(epochNumber);
      if (skippable === undefined) {
        skippable = await this.isEpochSkippable(epochNumber, l1Constants);
        epochSkippable.set(epochNumber, skippable);
      }
      if (skippable) {
        this.log.debug(`Skipping checkpoint ${metadata.checkpointNumber}: epoch ${epochNumber} is not to be proven`, {
          checkpointNumber: metadata.checkpointNumber,
          epochNumber,
        });
      } else {
        await this.registerCheckpoint(metadata.checkpointNumber, epochNumber);
      }
      this.lastProcessedCheckpoint = metadata.checkpointNumber;
    }
  }

  /** Fetches one checkpoint, registers it with the store, and reports it. Throws if any step fails. */
  private async registerCheckpoint(checkpointNumber: CheckpointNumber, epochNumber: EpochNumber): Promise<void> {
    const published = await this.deps.l2BlockSource.getCheckpoint({ number: checkpointNumber });
    if (!published) {
      throw new Error(`Checkpoint ${checkpointNumber} not found in block source during catch-up`);
    }
    const checkpoint = published.checkpoint;
    this.log.info(`New checkpoint ${checkpoint.number} for epoch ${epochNumber}`, {
      checkpointNumber: checkpoint.number,
      epochNumber,
      slotNumber: checkpoint.header.slotNumber,
    });

    // A retry can revisit a checkpoint already in the store. Its register data would be discarded, and collecting it
    // reads world-state history that may since have been pruned.
    if (!this.deps.checkpointStore.getByCheckpoint(checkpoint)) {
      const registerData = await this.collectRegisterData(checkpoint, published);
      await this.deps.checkpointStore.addOrUpdate(checkpoint, registerData);
    }
    await this.deps.handlers.onCheckpointRegistered(epochNumber);

    // Tips-only mode delivers no blocks, so record one witness per checkpointed block: a reorg into the checkpoint's
    // range then prunes at the true divergence instead of the nearest sparse tip anchor.
    await this.tipsStore.recordBlockHashes(
      await Promise.all(
        checkpoint.blocks.map(async block => ({ number: block.number, hash: (await block.header.hash()).toString() })),
      ),
    );
  }

  /** Gathers what a checkpoint prover needs beyond the checkpoint itself. */
  private async collectRegisterData(
    checkpoint: Checkpoint,
    published: Pick<PublishedCheckpoint, 'verbatimAttestations'>,
  ): Promise<RegisterCheckpointData> {
    const previousBlockNumber = BlockNumber(checkpoint.blocks[0].number - 1);
    const previousBlockHeader = await this.getBlockHeader(previousBlockNumber);
    const lastBlock = checkpoint.blocks.at(-1)!;
    // The checkpoint consumes the messages between its parent checkpoint's leaf count and its last block's leaf
    // count. The prover slices them per block.
    const { messages: l1ToL2Messages, end } = await this.deps.l1ToL2MessageSource.getL1ToL2MessageRange(
      BigInt(previousBlockHeader.state.l1ToL2MessageTree.nextAvailableLeafIndex),
      BigInt(lastBlock.header.state.l1ToL2MessageTree.nextAvailableLeafIndex),
    );
    // A count-matching range can still hold a pre-reorg version of the messages while the source recovers. The store
    // keeps a prover's messages for good, so throw and let the next pass retry rather than freeze a list that can
    // never prove this checkpoint.
    if (!end.rollingHash.equals(checkpoint.header.inboxRollingHash)) {
      throw new Error(
        `L1-to-L2 messages for checkpoint ${checkpoint.number} do not match its inbox rolling hash: ` +
          `source has ${end.rollingHash} at message count ${end.totalMessageCount}, ` +
          `checkpoint committed to ${checkpoint.header.inboxRollingHash}`,
      );
    }
    const previousInboxRollingHash = await this.getPreviousInboxRollingHash(checkpoint.number);
    const lastBlockHash = await lastBlock.header.hash();
    await this.deps.worldState.syncImmediate(lastBlock.number, lastBlockHash);
    const previousArchiveSiblingPath = await getLastSiblingPath(
      MerkleTreeId.ARCHIVE,
      this.deps.worldState.getSnapshot(previousBlockNumber),
    );
    return {
      verbatimAttestations: published.verbatimAttestations,
      previousBlockHeader,
      l1ToL2Messages,
      previousInboxRollingHash,
      previousArchiveSiblingPath,
    };
  }

  /** The previous checkpoint's inbox rolling hash, or zero for the first checkpoint. */
  private async getPreviousInboxRollingHash(checkpointNumber: CheckpointNumber): Promise<Fr> {
    if (checkpointNumber <= 1) {
      return Fr.ZERO;
    }
    const previous = await this.deps.l2BlockSource.getCheckpoint({ number: CheckpointNumber(checkpointNumber - 1) });
    if (!previous) {
      throw new Error(`Previous checkpoint ${checkpointNumber - 1} not found when sourcing inbox rolling hash`);
    }
    return previous.checkpoint.header.inboxRollingHash;
  }

  private async getBlockHeader(blockNumber: BlockNumber) {
    const data = await this.deps.l2BlockSource.getBlockData({ number: blockNumber });
    if (!data?.header) {
      throw new Error(`Header of block ${blockNumber} not found`);
    }
    return data.header;
  }

  /**
   * Decides whether catch-up skips an epoch's checkpoints instead of registering them.
   *
   * - Past its proof-submission window: skip. L1 no longer accepts a proof of it.
   * - Not fully proven yet: register.
   * - Fully proven, on a node with full-epoch proving disabled: skip. That node never proves a full epoch.
   * - Fully proven, and L1 already holds our own full-epoch proof of it: skip.
   * - Fully proven, but world state no longer holds a snapshot that one of its checkpoints not yet in the store needs,
   *   because a small `WS_HISTORY_RETENTION` pruned it once the epoch was finalized: skip. Registering would fail and
   *   stall the catch-up of every later checkpoint.
   * - Fully proven otherwise: register. The proof that moved the tip may be another prover's, or may have landed
   *   before the epoch ended, and L1 still rewards ours. If L1 cannot be read, register anyway; the session manager
   *   checks again before proving.
   */
  private async isEpochSkippable(epoch: EpochNumber, l1Constants: L1RollupConstants): Promise<boolean> {
    if (await this.isEpochPastProofSubmissionWindow(epoch, l1Constants)) {
      return true;
    }
    if (!(await this.deps.proofStatus.isEpochFullyProven(epoch))) {
      return false;
    }
    if (this.deps.config.disableFullEpochProving) {
      return true;
    }
    const checkpoints = await this.deps.l2BlockSource.getCheckpointsData({ epoch });
    if ((await this.deps.proofStatus.readOwnFullEpochProof(epoch, checkpoints.length)) === true) {
      return true;
    }
    const stored = await this.deps.checkpointStore.listForEpoch(epoch);
    const unregistered = checkpoints.filter(
      c =>
        !stored.some(
          p => p.checkpoint.number === c.checkpointNumber && p.checkpoint.archive.root.equals(c.archive.root),
        ),
    );
    // Checkpoints come in ascending order, so the first unregistered one that reads a prunable snapshot reads the
    // oldest one.
    const oldestRequiredSnapshot = unregistered.map(getOldestPrunableSnapshot).find(block => block !== undefined);
    if (oldestRequiredSnapshot === undefined) {
      return false;
    }
    const { oldestHistoricBlockNumber } = (await this.deps.worldState.status()).syncSummary;
    if (oldestRequiredSnapshot < oldestHistoricBlockNumber) {
      this.log.warn(`Not proving fully-proven epoch ${epoch}: world-state history it needs has been pruned`, {
        epoch,
        oldestRequiredSnapshot,
        oldestHistoricBlockNumber,
      });
      return true;
    }
    return false;
  }

  /** False while the archiver has no synced slot, so that nothing is skipped on an unknown chain position. */
  private async isEpochPastProofSubmissionWindow(
    epochNumber: EpochNumber,
    l1Constants: L1RollupConstants,
  ): Promise<boolean> {
    const latestSlot = await this.deps.l2BlockSource.getSyncedL2SlotNumber();
    if (latestSlot === undefined) {
      return false;
    }
    const latestEpoch = getEpochAtSlot(latestSlot, l1Constants);
    return latestEpoch >= getProofSubmissionDeadlineEpoch(epochNumber, l1Constants);
  }

  /**
   * Removes the provers orphaned by a prune, moves the cursor back below the prune target's checkpoint, and reports
   * the affected epochs. Works from the prune target block (the highest surviving block), not from the archiver's
   * checkpointed tip, which can already sit above the target after a re-checkpoint.
   */
  private async handlePrune(prunedToBlock: L2BlockId) {
    this.log.warn(`Chain pruned to block ${prunedToBlock.number}`, { prunedToBlock });

    // Resolve the cursor floor before removing provers. If this throws, nothing has changed and the next pass
    // retries the whole prune. Removing first would leave the retry with no provers to report.
    let cursorFloor: CheckpointNumber;
    if (prunedToBlock.number === 0) {
      cursorFloor = CheckpointNumber.ZERO;
    } else {
      const targetData = await this.deps.l2BlockSource.getBlockData({ number: prunedToBlock.number });
      if (targetData === undefined) {
        throw new Error(
          `No block data found for prune target block ${prunedToBlock.number}; cannot clamp checkpoint cursor`,
        );
      }
      // One below the checkpoint that holds the target block: a target inside a checkpoint leaves that checkpoint
      // partly orphaned, so it must be registered again. Moving back too far only re-registers a checkpoint. Not
      // moving back far enough would skip a rebuilt checkpoint with the same number.
      cursorFloor = CheckpointNumber(Math.max(0, Number(targetData.checkpointNumber) - 1));
    }

    const affected = this.deps.checkpointStore.cancelAndRemoveAboveBlock(prunedToBlock.number);
    this.deps.handlers.onChainPruned?.(BlockNumber(prunedToBlock.number));

    if (this.lastProcessedCheckpoint > cursorFloor) {
      this.lastProcessedCheckpoint = cursorFloor;
    }

    if (affected.length === 0) {
      return;
    }
    const l1Constants = await this.deps.l2BlockSource.getL1Constants();
    const affectedEpochs = unique(affected.map(p => Number(getEpochAtSlot(p.slotNumber, l1Constants)))).map(n =>
      EpochNumber(n),
    );
    await this.deps.handlers.onPruned(affectedEpochs);
  }
}

/**
 * Returns the oldest world-state snapshot that proving the checkpoint reads and that pruning can remove, or undefined
 * if it reads none. Proving block `b` reads the snapshot of block `b - 1`. The genesis snapshot (block 0) is never
 * pruned, so a checkpoint starting at block 1 reads a prunable snapshot only if it holds a second block.
 */
function getOldestPrunableSnapshot({
  startBlock,
  blockCount,
}: Pick<CommonCheckpointData, 'startBlock' | 'blockCount'>): BlockNumber | undefined {
  if (startBlock > 1) {
    return BlockNumber(startBlock - 1);
  }
  return blockCount > 1 ? BlockNumber(1) : undefined;
}
