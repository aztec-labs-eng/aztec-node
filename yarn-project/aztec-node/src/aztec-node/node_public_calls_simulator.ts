import { MAX_L1_TO_L2_MSGS_PER_BLOCK, MAX_L1_TO_L2_MSGS_PER_CHECKPOINT } from '@aztec-labs/constants';
import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { BlockNumber, type SlotNumber } from '@aztec-labs/foundation/branded-types';
import { BadRequestError } from '@aztec-labs/foundation/json-rpc';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { isErrorClass } from '@aztec-labs/foundation/types';
import { type InboxBucketSource, selectInboxBucketForBlock } from '@aztec-labs/sequencer-client';
import { type AvmSimulator, PublicContractsDB, PublicProcessorFactory } from '@aztec-labs/simulator/server';
import { CollectionLimitsConfig, PublicSimulatorConfig } from '@aztec-labs/stdlib/avm';
import { BlockHash, type L2BlockSource, type L2Frontier } from '@aztec-labs/stdlib/block';
import type { ContractDataSource } from '@aztec-labs/stdlib/contract';
import type { MerkleTreeWriteOperations, WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import {
  type L1ToL2MessageSource,
  appendL1ToL2MessagesToTree,
  getInboxCutoffTimestamp,
} from '@aztec-labs/stdlib/messaging';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';
import { type GlobalVariables, PublicSimulationOutput, type SimulationOverrides, type Tx } from '@aztec-labs/stdlib/tx';
import { type TelemetryClient, getTelemetryClient } from '@aztec-labs/telemetry-client';
import { WorldStateSynchronizerError } from '@aztec-labs/world-state';

import type { NextBlockPlan, NextBlockPredictor } from './next_block/index.js';
import { applyPublicDataOverrides } from './public_data_overrides.js';

/** Inbox queries the simulator needs to predict the message bundle the next block would consume. */
type SimulatorInboxSource = InboxBucketSource & Pick<L1ToL2MessageSource, 'getInboxBucketByTotalMsgCount'>;

/** Attempts at planning the next block on a chain the world state agrees with, before giving up. */
const MAX_PREDICTION_ATTEMPTS = 2;

/** Config fields the simulator needs — a narrow subset of `AztecNodeConfig`. */
export interface NodePublicCallsSimulatorConfig {
  /** Maximum total gas limit accepted for an incoming simulation. */
  rpcSimulatePublicMaxGasLimit: number;
  /** Maximum number of debug-log memory reads collected during simulation. */
  rpcSimulatePublicMaxDebugLogMemoryReads: number;
}

/** Dependencies required to build a {@link NodePublicCallsSimulator}. */
export interface NodePublicCallsSimulatorDeps {
  worldStateSynchronizer: WorldStateSynchronizer;
  /** Read only for the message total of the block a mid-checkpoint prediction's per-checkpoint cap starts from. */
  blockSource: L2BlockSource;
  /** Inbox bucket queries, used to predict the L1-to-L2 messages the next block will consume. */
  l1ToL2MessageSource: SimulatorInboxSource;
  contractDataSource: ContractDataSource;
  predictor: NextBlockPredictor;
  epochCache: EpochCacheInterface;
  config: NodePublicCallsSimulatorConfig;
  /**
   * AVM execution backend the public processor drives to run public calls. Optional because unit/TXE nodes
   * that never call {@link simulate} are constructed without one; asserted at the simulation call site.
   */
  avmSimulator?: AvmSimulator;
  telemetry?: TelemetryClient;
  log?: Logger;
}

/** The next block, planned and priced, on a chain the world state has caught up with. */
type PreparedNextBlock = {
  plan: NextBlockPlan;
  globals: GlobalVariables;
  /** Snapshot the plan was derived from, so the message prediction reads the same instant. */
  frontier: L2Frontier;
};

/**
 * Simulates the public part of a transaction against a fresh world-state fork.
 *
 * Extracted from `AztecNodeService` so forking and execution can be unit-tested without standing up the whole
 * node, and to keep `server.ts` smaller. Which block is simulated, and the globals it carries, are decided by
 * the {@link NextBlockPredictor}: the simulator's job is to fork the chain that plan describes, insert the
 * L1-to-L2 messages the next block would consume, and run the processor.
 */
export class NodePublicCallsSimulator {
  private readonly worldStateSynchronizer: WorldStateSynchronizer;
  private readonly blockSource: L2BlockSource;
  private readonly l1ToL2MessageSource: SimulatorInboxSource;
  private readonly contractDataSource: ContractDataSource;
  private readonly predictor: NextBlockPredictor;
  private readonly epochCache: EpochCacheInterface;
  private readonly config: NodePublicCallsSimulatorConfig;
  private readonly avmSimulator?: AvmSimulator;
  private readonly telemetry: TelemetryClient;
  private readonly log: Logger;
  private readonly dateProvider = new DateProvider();

  constructor(deps: NodePublicCallsSimulatorDeps) {
    this.worldStateSynchronizer = deps.worldStateSynchronizer;
    this.blockSource = deps.blockSource;
    this.l1ToL2MessageSource = deps.l1ToL2MessageSource;
    this.contractDataSource = deps.contractDataSource;
    this.predictor = deps.predictor;
    this.epochCache = deps.epochCache;
    this.config = deps.config;
    this.avmSimulator = deps.avmSimulator;
    this.telemetry = deps.telemetry ?? getTelemetryClient();
    this.log = deps.log ?? createLogger('node:public-calls-simulator');
  }

  /**
   * Simulates the public part of a transaction with the current state.
   * @param tx - The transaction to simulate.
   * @param skipFeeEnforcement - If true, fee enforcement is skipped.
   * @param overrides - Optional pre-simulation overrides applied to the ephemeral fork and contract DB.
   */
  public async simulate(
    tx: Tx,
    skipFeeEnforcement = false,
    overrides?: SimulationOverrides,
  ): Promise<PublicSimulationOutput> {
    // Check total gas limit for simulation
    const gasSettings = tx.data.constants.txContext.gasSettings;
    const txGasLimit = gasSettings.gasLimits.l2Gas;
    const teardownGasLimit = gasSettings.teardownGasLimits.l2Gas;
    if (txGasLimit + teardownGasLimit > this.config.rpcSimulatePublicMaxGasLimit) {
      throw new BadRequestError(
        `Transaction total gas limit ${
          txGasLimit + teardownGasLimit
        } (${txGasLimit} + ${teardownGasLimit}) exceeds maximum gas limit ${
          this.config.rpcSimulatePublicMaxGasLimit
        } for simulation`,
      );
    }

    const txHash = tx.getTxHash();
    const { plan, globals, frontier } = await this.prepareNextBlock();

    if (!this.avmSimulator) {
      throw new Error('NodePublicCallsSimulator.simulate requires an AVM simulator, but none was configured');
    }
    const publicProcessorFactory = new PublicProcessorFactory(
      this.contractDataSource,
      this.avmSimulator,
      this.dateProvider,
      this.telemetry,
      this.log.getBindings(),
    );

    this.log.verbose(`Simulating public calls for tx ${txHash}`, {
      globalVariables: globals.toInspect(),
      txHash,
      blockNumber: globals.blockNumber,
      atCheckpointBoundary: plan.newCheckpoint !== undefined,
    });

    // Request a new fork of the world state at the latest block number, then apply the next block's predicted
    // L1-to-L2 message bundle and any caller overrides to it before simulation.
    await using merkleTreeFork = await this.worldStateSynchronizer.fork(plan.latestBlockNumber);

    await this.appendPredictedL1ToL2Messages(merkleTreeFork, {
      slotNumber: globals.slotNumber,
      checkpointStartBlock: plan.newCheckpoint ? undefined : proposedCheckpointLastBlock(frontier),
    });

    await applyPublicDataOverrides(merkleTreeFork, overrides?.publicStorage);

    const config = PublicSimulatorConfig.from({
      skipFeeEnforcement,
      collectDebugLogs: true,
      collectHints: false,
      collectCallMetadata: true,
      collectStatistics: false,
      collectionLimits: CollectionLimitsConfig.from({
        maxDebugLogMemoryReads: this.config.rpcSimulatePublicMaxDebugLogMemoryReads,
      }),
    });

    const contractsDB = new PublicContractsDB(this.contractDataSource, this.log.getBindings());
    if (overrides?.contracts) {
      contractsDB.addContracts(Object.values(overrides.contracts).map(({ instance }) => instance));
    }
    const processor = publicProcessorFactory.create(merkleTreeFork, globals, config, contractsDB);

    // REFACTOR: Consider merging ProcessReturnValues into ProcessedTx
    const [processedTxs, failedTxs, _usedTxs, returns, debugLogs] = await processor.process([tx]);
    // REFACTOR: Consider returning the error rather than throwing
    if (failedTxs.length) {
      this.log.warn(`Simulated tx ${txHash} fails: ${failedTxs[0].error}`, { txHash });
      throw failedTxs[0].error;
    }

    const [processedTx] = processedTxs;
    return new PublicSimulationOutput(
      processedTx.revertReason,
      processedTx.globalVariables,
      processedTx.txEffect,
      returns,
      processedTx.gasUsed,
      debugLogs,
    );
  }

  /**
   * Plans and prices the next block, and brings the world state up to the block that plan builds on. Retries
   * once when the world state reaches the planned height with a different block: a prune between the archiver
   * read and the sync leaves the two disagreeing, and forking anyway would simulate against state the plan's
   * globals do not belong to. Any other sync failure propagates as is.
   */
  private async prepareNextBlock(): Promise<PreparedNextBlock> {
    for (let attempt = 0; attempt < MAX_PREDICTION_ATTEMPTS; attempt++) {
      const { plan, globals, frontier } = await this.predictor.predict();
      try {
        // Passing the hash makes the sync fork-aware: it waits for the block the plan builds on and throws if
        // the world state ended up with a different block at that height.
        await this.worldStateSynchronizer.syncImmediate(
          plan.latestBlockNumber,
          BlockHash.fromString(plan.latestBlockHash),
        );
        return { plan, globals, frontier };
      } catch (err) {
        if (!isBlockHashMismatch(err)) {
          throw err;
        }
        this.log.warn(`World state disagrees with the planned next block, replanning`, {
          blockNumber: plan.latestBlockNumber,
          blockHash: plan.latestBlockHash,
          error: err.message,
        });
      }
    }

    throw new Error(
      `Cannot simulate public calls: world state and archiver disagree on the latest block (prune race), retry`,
    );
  }

  /**
   * Appends the L1-to-L2 message bundle the next block would consume to the simulation fork, so a transaction
   * consuming a message that has reached the Inbox but no block yet simulates against the state it will run in.
   * Runs the same bucket selection the sequencer runs (lag eligibility plus the per-block and per-checkpoint caps),
   * treating the next block as non-final: the censorship cutoff only widens consumption on a checkpoint's last
   * block, and the node cannot know whether the next block is it.
   *
   * Best-effort. Any failure — Inbox buckets not synced yet, a torn archiver snapshot — leaves the fork at the tip
   * state, which is what the transaction sees if the next block consumes nothing.
   */
  private async appendPredictedL1ToL2Messages(
    fork: MerkleTreeWriteOperations,
    opts: {
      /** Slot the next block lands in; anchors the censorship cutoff. */
      slotNumber: SlotNumber;
      /** Last block of the checkpoint the next block extends; undefined when the next block opens a checkpoint. */
      checkpointStartBlock: BlockNumber | undefined;
    },
  ): Promise<void> {
    try {
      const parentTotalMsgCount = (await fork.getTreeInfo(MerkleTreeId.L1_TO_L2_MESSAGE_TREE)).size;
      const parentBucket = await this.l1ToL2MessageSource.getInboxBucketByTotalMsgCount(parentTotalMsgCount);
      if (parentBucket === undefined) {
        this.log.debug(`Inbox bucket at message total ${parentTotalMsgCount} not synced; simulating against the tip`, {
          parentTotalMsgCount,
        });
        return;
      }

      // Origin of the per-checkpoint cap: the total consumed as of the checkpoint's parent. A block extending an
      // in-progress checkpoint reads it off that checkpoint's parent block; a block opening one starts from the tip.
      const checkpointStartTotalMsgCount =
        opts.checkpointStartBlock === undefined
          ? parentTotalMsgCount
          : await this.getConsumedMessageTotal(opts.checkpointStartBlock);
      if (checkpointStartTotalMsgCount === undefined) {
        this.log.debug(`Block ${opts.checkpointStartBlock} has no header on this node; simulating against the tip`);
        return;
      }

      const l1Constants = this.epochCache.getL1Constants();
      const selection = await selectInboxBucketForBlock({
        messageSource: this.l1ToL2MessageSource,
        now: BigInt(Math.floor(this.dateProvider.now() / 1000)),
        minBucketAgeSeconds: BigInt(l1Constants.ethereumSlotDuration),
        parent: { seq: parentBucket.seq, totalMsgCount: parentBucket.totalMsgCount },
        checkpointStartTotalMsgCount,
        perBlockCap: MAX_L1_TO_L2_MSGS_PER_BLOCK,
        perCheckpointCap: MAX_L1_TO_L2_MSGS_PER_CHECKPOINT,
        isLastBlock: false,
        cutoffTimestamp: getInboxCutoffTimestamp(opts.slotNumber, l1Constants),
      });
      if (!selection.consume || selection.bundle.length === 0) {
        return;
      }

      await appendL1ToL2MessagesToTree(fork, selection.bundle);
      this.log.debug(`Appended ${selection.bundle.length} predicted L1-to-L2 messages to the simulation fork`, {
        bucketSeq: selection.bucket.seq,
        messageCount: selection.bundle.length,
      });
    } catch (err) {
      this.log.verbose(`Could not predict the next block's L1-to-L2 messages, simulating against the tip: ${err}`);
    }
  }

  /** Cumulative Inbox message total consumed as of `blockNumber`, i.e. its L1-to-L2 message tree leaf count. */
  private async getConsumedMessageTotal(blockNumber: BlockNumber): Promise<bigint | undefined> {
    if (blockNumber === BlockNumber.ZERO) {
      return 0n;
    }
    const block = await this.blockSource.getBlockData({ number: blockNumber });
    return block === undefined ? undefined : BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex);
  }
}

/**
 * Terminating block of the proposed-checkpoint frontier: the leading proposed (not-yet-L1-confirmed)
 * checkpoint's last block is `startBlock + blockCount - 1`; with no proposed checkpoint the frontier
 * coincides with the checkpointed tip. Where the per-checkpoint message cap starts counting from for a block
 * that continues an in-progress checkpoint.
 */
function proposedCheckpointLastBlock(frontier: L2Frontier): BlockNumber {
  const proposed = frontier.proposedCheckpoint;
  return proposed
    ? BlockNumber.add(proposed.startBlock, proposed.blockCount - 1)
    : frontier.tips.checkpointed.block.number;
}

/** The sync reached the planned height but found a different block there, so the chain moved under the plan. */
function isBlockHashMismatch(err: unknown): err is WorldStateSynchronizerError {
  return (
    isErrorClass(err, WorldStateSynchronizerError) &&
    typeof err.cause === 'object' &&
    err.cause !== null &&
    'reason' in err.cause &&
    err.cause.reason === 'block_hash_mismatch'
  );
}
