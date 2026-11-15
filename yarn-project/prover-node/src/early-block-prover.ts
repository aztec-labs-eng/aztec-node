import { BlockNumber, type SlotNumber } from '@aztec-labs/foundation/branded-types';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
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

/** Upper bound on the blocks fetched for one move of the proposed tip. */
const MAX_BLOCKS_PER_FETCH = 100;

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
 * by its inputs, so it serves those requests from the jobs started here. A block that is pruned before its
 * checkpoint lands is never requested again, so its jobs are never used.
 *
 * Everything here is best-effort. A failure is logged and the affected slot is dropped; the checkpoint is still
 * proven the usual way.
 */
export class EarlyBlockProver {
  private readonly log: Logger;
  /** Early proving in progress, by slot. A checkpoint holds the blocks of one slot. */
  private readonly slots = new Map<SlotNumber, SlotInProgress>();
  /** Last block already handled. Undefined until the first proposed tip is seen. */
  private lastBlock: BlockNumber | undefined;
  private stopped = false;

  constructor(private readonly deps: EarlyBlockProverDeps) {
    this.log = createLogger('prover-node:early-block-prover', deps.bindings);
  }

  /** The proposed tip moved. Starts proving every block up to it that has not been seen yet. Never throws. */
  public async onChainProposed(tip: BlockNumber): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      // Checkpointed blocks are proven by their `CheckpointProver`. On the first call this also places the cursor,
      // so a node that starts mid-chain does not walk back through history.
      const checkpointed = (await this.deps.l2BlockSource.getBlockNumber({ tag: 'checkpointed' })) ?? BlockNumber.ZERO;
      const from = BlockNumber(Math.max(this.lastBlock ?? checkpointed, checkpointed) + 1);
      if (tip < from) {
        return;
      }
      const limit = Math.min(tip - from + 1, MAX_BLOCKS_PER_FETCH);
      const blocks = await this.deps.l2BlockSource.getBlocks({ from, limit });
      for (const block of blocks) {
        await this.addBlock(block);
        this.lastBlock = block.number;
      }
    } catch (err) {
      this.log.warn(`Could not start early proving up to block ${tip}`, { tip, err });
    }
  }

  /** A checkpoint landed. Releases the slots whose blocks it covers; their `CheckpointProver`s take over. */
  public onChainCheckpointed(checkpointedBlock: BlockNumber): void {
    for (const [slot, work] of this.slots) {
      if (work.lastBlockNumber <= checkpointedBlock) {
        this.slots.delete(slot);
        this.release(work);
      }
    }
  }

  /** The chain was pruned back to `prunedToBlock`. Drops every slot that holds a removed block. */
  public onChainPruned(prunedToBlock: BlockNumber): void {
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
      this.slots.delete(slot);
      this.release(work);
      // The removed blocks' transactions are not in the chain any more. Checkpointed blocks have their entries
      // released when their epoch expires; these blocks never get there.
      this.deps.chonkCache.releaseForBlocks(work.getBlocks().filter(block => block.number > prunedToBlock));
      resumeAfter = BlockNumber(Math.min(resumeAfter, work.firstBlockNumber - 1));
    }
    if (this.lastBlock !== undefined && this.lastBlock > resumeAfter) {
      this.lastBlock = resumeAfter;
    }
  }

  /** Stops all early proving and waits for it to unwind. */
  public async stop(): Promise<void> {
    this.stopped = true;
    const works = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(works.map(work => work.release()));
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
        // The slot's earlier blocks were not seen, or its early proving was dropped. A block's proving inputs
        // depend on the blocks before it in the slot, so the rest of the slot is left to its checkpoint.
        this.log.debug(`Not proving block ${block.number} early: slot ${slot} is not being proven from its start`);
        return;
      }
      work = new SlotInProgress(slot, previousHeader, this.deps, this.log);
      this.slots.set(slot, work);
      this.dropOldestSlots();
    }
    work.add(block);
  }

  private dropOldestSlots(): void {
    while (this.slots.size > MAX_SLOTS_IN_PROGRESS) {
      const oldest = Math.min(...this.slots.keys()) as SlotNumber;
      this.log.warn(`Dropping early proving for slot ${oldest}: too many slots without a checkpoint`, { slot: oldest });
      this.release(this.slots.get(oldest)!);
      this.slots.delete(oldest);
    }
  }

  /** Releases a slot's work in the background. */
  private release(work: SlotInProgress): void {
    void work.release().catch(err => this.log.warn(`Error releasing early proving`, { err }));
  }
}

/** Early proving of the blocks proposed so far in one slot. */
class SlotInProgress {
  private readonly blocks: L2Block[] = [];
  private readonly abortController = new AbortController();
  private subTree: CheckpointSubTreeOrchestrator | undefined;
  /** Blocks are proven one after the other, in the order they were added. */
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly slot: SlotNumber,
    /** Header of the last block before this slot's first block. */
    private readonly previousHeader: BlockHeader,
    private readonly deps: EarlyBlockProverDeps,
    private readonly log: Logger,
  ) {}

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
    this.queue = this.queue.then(async () => {
      if (this.failed || this.abortController.signal.aborted) {
        return;
      }
      try {
        await this.prove(block, parentHeader);
      } catch (err) {
        this.failed = true;
        if (!this.abortController.signal.aborted) {
          this.log.warn(`Early proving of block ${block.number} failed; leaving slot ${this.slot} to its checkpoint`, {
            blockNumber: block.number,
            slot: this.slot,
            err,
          });
        }
      }
    });
  }

  /** Stops the work in this slot. The broker jobs it started keep running, for the checkpoint to reuse. */
  public async release(): Promise<void> {
    this.abortController.abort();
    await this.queue;
    await this.subTree?.stop();
  }

  private async prove(block: L2Block, parentHeader: BlockHeader): Promise<void> {
    const signal = this.abortController.signal;
    const timer = new Timer();

    await this.deps.worldState.syncImmediate(block.number, await block.hash());
    const { messages } = await this.deps.l1ToL2MessageSource.getL1ToL2MessageRange(
      BigInt(parentHeader.state.l1ToL2MessageTree.nextAvailableLeafIndex),
      BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex),
    );
    const deadline = new Date(this.deps.dateProvider.now() + this.deps.txGatheringTimeoutMs);
    const { txs, missingTxs } = await this.deps.txProvider.getTxsForBlock(block, { deadline, signal });
    if (signal.aborted) {
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
    }
    const subTree = this.subTree;

    const publicTxs = blockTxs.filter(tx => tx.data.forPublic);
    if (publicTxs.length > 0) {
      await subTree.startChonkVerifierCircuits(publicTxs);
    }
    if (!(await executeBlock(subTree, block, blockTxs, messages, this.deps, signal))) {
      return;
    }
    this.log.info(`Started block-level proving for block ${block.number} ahead of its checkpoint`, {
      blockNumber: block.number,
      slot: this.slot,
      txCount: blockTxs.length,
      durationMs: timer.ms(),
    });

    void subTree.whenBlockRootProven(block.number).then(() =>
      this.log.info(`Block-level proofs ready for block ${block.number} ahead of its checkpoint`, {
        blockNumber: block.number,
        slot: this.slot,
        // Time from the block reaching this prover to its block root proof.
        durationMs: timer.ms(),
      }),
    );
  }
}
