import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { type DateProvider, Timer } from '@aztec-labs/foundation/timer';
import type { EpochProverFactory } from '@aztec-labs/prover-client';
import type { CheckpointSubTreeOrchestrator, ChonkCache } from '@aztec-labs/prover-client/orchestrator';
import type { L2Block, L2BlockSource } from '@aztec-labs/stdlib/block';
import { getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';
import type { ITxProvider, WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import { type BlockExecutionDeps, executeBlock, makeCheckpointConstants } from './job/block-execution.js';

/** How many slots can have early proving in progress. A slot normally leaves when its checkpoint lands. */
const MAX_SLOTS_IN_PROGRESS = 4;

/** How many blocks are fetched from the archiver at a time. */
const BLOCKS_PER_FETCH = 100;

/** What early proving reads blocks, messages and transactions from, and what it proves them with. */
export type EarlyBlockProverDeps = BlockExecutionDeps & {
  l2BlockSource: Pick<L2BlockSource, 'getBlocks' | 'getBlockData' | 'getBlockNumber' | 'getL1Constants'>;
  l1ToL2MessageSource: Pick<L1ToL2MessageSource, 'getL1ToL2MessageRange'>;
  worldState: Pick<WorldStateSynchronizer, 'syncImmediate'>;
  proverFactory: Pick<EpochProverFactory, 'createBlocksOnlySubTreeOrchestrator'>;
  chonkCache: ChonkCache;
  txProvider: ITxProvider;
  dateProvider: DateProvider;
  /** How long to wait for a block's transactions. */
  txGatheringTimeoutMs: number;
  bindings?: LoggerBindings;
};

/**
 * Starts block-level proving for a block as soon as the archiver holds it, without waiting for its checkpoint to
 * land on L1.
 *
 * The proofs it starts are not handed to anything. When the checkpoint lands, the node proves it through the
 * usual `CheckpointProver`, which requests proving jobs with the same inputs. The proving broker identifies a job
 * by its inputs, so it serves those requests from the jobs started here. The jobs of a block that is pruned before
 * its checkpoint lands are used only if a block with the same inputs is proposed again.
 *
 * The archiver must hold proposed blocks for this to do anything. A node that does not re-execute block proposals
 * only learns of blocks from their checkpoints, and then no block is ever proven early.
 *
 * Early proving never aborts a broker job. A `CheckpointProver` may be waiting on the same job, and an abort would
 * fail it. The jobs of a pruned block therefore run to completion on the agents.
 *
 * A failure here is logged and stops early proving for the affected slot. Its checkpoint is still proven the usual
 * way. One failure does reach the checkpoint: the broker stores a job that failed after all its retries, and
 * answers the `CheckpointProver`'s request for the same job with that failure.
 *
 * A block is proven early only if a checkpoint of its epoch has already landed. The broker drops the jobs of old
 * epochs once it sees a job of a newer epoch, and a block can be proposed shortly before its epoch starts. Proving
 * it then would make the broker drop the jobs of an epoch whose proof-submission window is still open.
 */
export class EarlyBlockProver {
  private readonly log: Logger;
  /** Chain events are handled one at a time, in the order they arrived, without holding up the caller. */
  private readonly events = new SerialQueue();
  /** Early proving in progress, by slot. A checkpoint holds the blocks of one slot. */
  private readonly slots = new Map<SlotNumber, SlotInProgress>();
  /** Slots removed from `slots` whose work is still unwinding. */
  private readonly releasing = new Set<Promise<void>>();
  /** Last block already handled. Undefined until the first proposed tip is seen. */
  private lastBlock: BlockNumber | undefined;
  private stopped = false;

  constructor(private readonly deps: EarlyBlockProverDeps) {
    this.log = createLogger('prover-node:early-block-prover', deps.bindings);
    this.events.start();
  }

  /** The proposed tip moved. Starts proving every block up to it that has not been seen yet. */
  public onChainProposed(tip: BlockNumber): void {
    this.handle(`proposed tip ${tip}`, () => this.catchUpTo(tip));
  }

  /** A checkpoint landed. Releases the slots whose blocks it covers; their `CheckpointProver`s take over. */
  public onChainCheckpointed(checkpointedBlock: BlockNumber): void {
    this.handle(`checkpointed tip ${checkpointedBlock}`, () => this.releaseCheckpointed(checkpointedBlock));
  }

  /** The chain was pruned back to `prunedToBlock`. Drops every slot that holds a removed block. */
  public onChainPruned(prunedToBlock: BlockNumber): void {
    this.handle(`prune to ${prunedToBlock}`, () => this.dropPruned(prunedToBlock));
  }

  /** Stops all early proving and waits for it to unwind. */
  public async stop(): Promise<void> {
    this.stopped = true;
    await this.events.cancel();
    for (const slot of [...this.slots.keys()]) {
      this.release(slot);
    }
    await Promise.all(this.releasing);
  }

  /** Queues the handling of a chain event. A failure is logged and does not reach the caller. */
  private handle(what: string, fn: () => void | Promise<void>): void {
    if (this.stopped) {
      return;
    }
    void this.events.put(fn).catch(err => {
      if (!this.stopped) {
        this.log.warn(`Early proving could not handle ${what}`, { event: what, err });
      }
    });
  }

  /**
   * Adds every block between the last one handled and the tip. If a read fails part-way, the blocks after the
   * failure are picked up when the proposed tip moves again.
   */
  private async catchUpTo(tip: BlockNumber): Promise<void> {
    // Checkpointed blocks are proven by their `CheckpointProver`. On the first call this also places the cursor,
    // so a node that starts mid-chain does not walk back through history.
    const checkpointed = (await this.deps.l2BlockSource.getBlockNumber({ tag: 'checkpointed' })) ?? BlockNumber.ZERO;
    const checkpointedHeader = (await this.deps.l2BlockSource.getBlockData({ number: checkpointed }))?.header;
    if (!checkpointedHeader) {
      throw new Error(`Header of checkpointed block ${checkpointed} not found`);
    }
    const l1Constants = await this.deps.l2BlockSource.getL1Constants();
    const checkpointedEpoch = getEpochAtSlot(checkpointedHeader.getSlot(), l1Constants);

    let from = BlockNumber(Math.max(this.lastBlock ?? checkpointed, checkpointed) + 1);
    while (from <= tip && !this.stopped) {
      const limit = Math.min(tip - from + 1, BLOCKS_PER_FETCH);
      const blocks = await this.deps.l2BlockSource.getBlocks({ from, limit });
      if (blocks.length === 0) {
        return;
      }
      for (const block of blocks) {
        if (getEpochAtSlot(block.slot, l1Constants) > checkpointedEpoch) {
          this.log.debug(`Not proving block ${block.number} early: no checkpoint of its epoch has landed yet`, {
            blockNumber: block.number,
            slot: block.slot,
            checkpointedEpoch,
          });
        } else {
          await this.addBlock(block);
        }
        this.lastBlock = block.number;
      }
      from = BlockNumber(blocks.at(-1)!.number + 1);
    }
  }

  private async addBlock(block: L2Block): Promise<void> {
    const slot = block.slot;
    let work = this.slots.get(slot);
    if (!work) {
      const previousHeader = (await this.deps.l2BlockSource.getBlockData({ number: BlockNumber(block.number - 1) }))
        ?.header;
      if (!previousHeader) {
        throw new Error(`Header of block ${block.number - 1} not found`);
      }
      if (previousHeader.getSlot() === slot) {
        // The slot's first block was not proven early. A block's proving inputs depend on the blocks before it in
        // the slot, so the rest of the slot is left to its checkpoint.
        this.log.debug(`Not proving block ${block.number} early: slot ${slot} is not being proven from its start`, {
          blockNumber: block.number,
          slot,
        });
        return;
      }
      work = new SlotInProgress(slot, previousHeader, this.deps, this.log);
      this.slots.set(slot, work);
      this.dropOldestSlots();
    }
    work.add(block);
  }

  private releaseCheckpointed(checkpointedBlock: BlockNumber): void {
    for (const [slot, work] of this.slots) {
      if (work.lastBlockNumber <= checkpointedBlock) {
        this.release(slot);
      }
    }
  }

  private dropPruned(prunedToBlock: BlockNumber): void {
    // Where the next proposed tip resumes from. A slot is proven from its first block on, so when a slot loses
    // some of its blocks, its surviving blocks are picked up again together with whatever replaces the lost ones.
    let resumeAfter = prunedToBlock;
    for (const [slot, work] of this.slots) {
      if (work.lastBlockNumber <= prunedToBlock) {
        continue;
      }
      this.log.info(`Dropping early proving for slot ${slot}: chain pruned to block ${prunedToBlock}`, {
        slot,
        prunedToBlock,
      });
      this.release(slot, { releaseChonkProofsAbove: prunedToBlock });
      resumeAfter = BlockNumber(Math.min(resumeAfter, work.firstBlockNumber - 1));
    }
    if (this.lastBlock !== undefined && this.lastBlock > resumeAfter) {
      this.lastBlock = resumeAfter;
    }
  }

  private dropOldestSlots(): void {
    while (this.slots.size > MAX_SLOTS_IN_PROGRESS) {
      const oldest = SlotNumber(Math.min(...this.slots.keys()));
      this.log.warn(`Dropping early proving for slot ${oldest}: too many slots without a checkpoint`, { slot: oldest });
      // Nothing tracks this slot from here on, so nothing would release its chonk proofs if it were pruned later.
      // If it is checkpointed instead, its `CheckpointProver` requests them again and the broker serves them.
      this.release(oldest, { releaseChonkProofsAbove: BlockNumber.ZERO });
    }
  }

  /**
   * Removes a slot and unwinds its work in the background. With `releaseChonkProofsAbove`, the chonk-verifier
   * cache entries of the slot's blocks above that block number are released once the work has stopped: while it
   * runs, it can still add entries. Entries of checkpointed blocks are released when their epoch expires; blocks
   * that never reach a checkpoint have only this.
   */
  private release(slot: SlotNumber, opts: { releaseChonkProofsAbove?: BlockNumber } = {}): void {
    const work = this.slots.get(slot);
    if (!work) {
      return;
    }
    this.slots.delete(slot);
    const { releaseChonkProofsAbove } = opts;
    const released = work
      .release()
      .then(() => {
        if (releaseChonkProofsAbove !== undefined) {
          const blocks = work.getBlocks().filter(block => block.number > releaseChonkProofsAbove);
          this.deps.chonkCache.releaseForBlocks(blocks);
        }
      })
      .catch(err => this.log.warn(`Error releasing early proving for slot ${slot}`, { slot, err }))
      .finally(() => this.releasing.delete(released));
    this.releasing.add(released);
  }
}

/** Early proving of the blocks proposed so far in one slot. */
class SlotInProgress {
  private readonly blocks: L2Block[] = [];
  private readonly abortController = new AbortController();
  /** Blocks are proven one after the other, in the order they were added. */
  private readonly queue = new SerialQueue();
  private subTree: CheckpointSubTreeOrchestrator | undefined;
  private failed = false;

  constructor(
    private readonly slot: SlotNumber,
    /** Header of the last block before this slot's first block. */
    private readonly previousHeader: BlockHeader,
    private readonly deps: EarlyBlockProverDeps,
    private readonly log: Logger,
  ) {
    this.queue.start();
  }

  public get firstBlockNumber(): BlockNumber {
    return BlockNumber(this.previousHeader.getBlockNumber() + 1);
  }

  public get lastBlockNumber(): BlockNumber {
    return BlockNumber(this.firstBlockNumber + this.blocks.length - 1);
  }

  public getBlocks(): readonly L2Block[] {
    return this.blocks;
  }

  public add(block: L2Block): void {
    const parentHeader = this.blocks.at(-1)?.header ?? this.previousHeader;
    this.blocks.push(block);
    // Started here, so the logged duration includes the wait behind earlier blocks of the slot.
    const sinceAdded = new Timer();
    // The queue rejects the call when it is cancelled before the block's turn, which needs no handling.
    void this.queue.put(() => this.proveOrGiveUp(block, parentHeader, sinceAdded)).catch(() => {});
  }

  /** Stops the work in this slot. The broker jobs it started keep running, for the checkpoint to reuse. */
  public async release(): Promise<void> {
    this.abortController.abort();
    await this.queue.cancel();
    await this.stopSubTree();
  }

  private async proveOrGiveUp(block: L2Block, parentHeader: BlockHeader, sinceAdded: Timer): Promise<void> {
    if (this.failed || this.abortController.signal.aborted) {
      return;
    }
    try {
      await this.prove(block, parentHeader, sinceAdded);
    } catch (err) {
      this.failed = true;
      // Frees the world-state forks the sub-tree holds. The slot stays in place so its later blocks are skipped.
      await this.stopSubTree();
      if (!this.abortController.signal.aborted) {
        this.log.warn(`Early proving of block ${block.number} failed; leaving slot ${this.slot} to its checkpoint`, {
          blockNumber: block.number,
          slot: this.slot,
          err,
        });
      }
    }
  }

  /**
   * A proving job can fail after the block that requested it has been executed. The sub-tree reports that through
   * its result, which nothing else here reads. Later blocks of the slot would build on the failed one, so the slot
   * stops being proven early.
   */
  private giveUpWhenAJobFails(subTree: CheckpointSubTreeOrchestrator): void {
    void subTree.getSubTreeResult().catch(async err => {
      // Stopping the sub-tree also rejects its result.
      if (this.failed || this.abortController.signal.aborted) {
        return;
      }
      this.failed = true;
      this.log.warn(`A proving job of slot ${this.slot} failed; leaving the slot to its checkpoint`, {
        slot: this.slot,
        err,
      });
      await this.stopSubTree();
    });
  }

  private async stopSubTree(): Promise<void> {
    const subTree = this.subTree;
    this.subTree = undefined;
    await subTree?.stop();
  }

  private async prove(block: L2Block, parentHeader: BlockHeader, sinceAdded: Timer): Promise<void> {
    const signal = this.abortController.signal;

    await this.deps.worldState.syncImmediate(block.number, await block.hash());
    const { messages } = await this.deps.l1ToL2MessageSource.getL1ToL2MessageRange(
      BigInt(parentHeader.state.l1ToL2MessageTree.nextAvailableLeafIndex),
      BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex),
    );
    const deadline = new Date(this.deps.dateProvider.now() + this.deps.txGatheringTimeoutMs);
    const { txs, missingTxs } = await this.deps.txProvider.getTxsForBlock(block, { deadline, signal });
    // A proving job of an earlier block may have failed meanwhile, which stops the slot's sub-tree. Going on would
    // start a second one from the slot's first block.
    if (signal.aborted || this.failed) {
      return;
    }
    if (missingTxs.length > 0) {
      throw new Error(`Txs not found for block ${block.number}: ${missingTxs.map(hash => hash.toString()).join(', ')}`);
    }
    const txsByHash = new Map(txs.map(tx => [tx.getTxHash().toString(), tx]));
    const blockTxs = block.body.txEffects.map(txEffect => txsByHash.get(txEffect.txHash.toString())!);

    if (!this.subTree) {
      const epochNumber = getEpochAtSlot(this.slot, await this.deps.l2BlockSource.getL1Constants());
      this.subTree = await this.deps.proverFactory.createBlocksOnlySubTreeOrchestrator(
        this.deps.chonkCache,
        epochNumber,
        makeCheckpointConstants(block.header.globalVariables, this.deps.proverId),
        this.previousHeader,
      );
      if (signal.aborted) {
        return;
      }
      this.giveUpWhenAJobFails(this.subTree);
    }
    const subTree = this.subTree;

    const publicTxs = blockTxs.filter(tx => tx.data.forPublic);
    if (publicTxs.length > 0) {
      await subTree.startChonkVerifierCircuits(publicTxs);
    }
    if (!(await executeBlock(subTree, block, blockTxs, messages, this.deps, signal))) {
      return;
    }
    const context = { blockNumber: block.number, slot: this.slot, txCount: blockTxs.length };
    this.log.info(`Started block-level proving for block ${block.number} ahead of its checkpoint`, {
      ...context,
      durationMs: sinceAdded.ms(),
    });

    // Logged only when the block root proof is ready before the slot is released. A block whose checkpoint lands
    // first has its proofs reported by its `CheckpointProver`.
    void subTree.whenBlockRootProven(block.number).then(async () => {
      // The slot is released when its checkpoint lands, after the archiver reports the block checkpointed. A proof
      // that arrives in between is not early, and neither is one whose block cannot be compared with the tip.
      const isAhead = await this.deps.l2BlockSource
        .getBlockNumber({ tag: 'checkpointed' })
        .then(checkpointed => block.number > (checkpointed ?? BlockNumber.ZERO))
        .catch(() => false);
      if (signal.aborted || !isAhead) {
        return;
      }
      this.log.info(`Block-level proofs ready for block ${block.number} ahead of its checkpoint`, {
        ...context,
        // Time from the block reaching this prover to its block root proof.
        durationMs: sinceAdded.ms(),
      });
    });
  }
}
