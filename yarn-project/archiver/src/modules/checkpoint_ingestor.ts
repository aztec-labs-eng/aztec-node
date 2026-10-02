import type { BlobClientInterface } from '@aztec-labs/blob-client/client';
import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { ViemPublicClient, ViemPublicDebugClient } from '@aztec-labs/ethereum/types';
import { asyncPool } from '@aztec-labs/foundation/async-pool';
import { BlockNumber, CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { partition, pick } from '@aztec-labs/foundation/collection';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import { elapsed } from '@aztec-labs/foundation/timer';
import {
  type ArchiverEmitter,
  type L2Block,
  L2BlockSourceEvents,
  type ValidateCheckpointResult,
} from '@aztec-labs/stdlib/block';
import { Checkpoint, type CheckpointInfo, PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import type { L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import type { CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';
import { type Tracer, execInSpan } from '@aztec-labs/telemetry-client';

import { InitialCheckpointNumberNotSequentialError } from '../errors.js';
import {
  type RetrievedCheckpointFromCalldata,
  getCheckpointBlobDataFromBlobs,
  retrieveCheckpointCalldataFromRollup,
  retrievedToPublishedCheckpoint,
} from '../l1/data_retrieval.js';
import type { RejectedCheckpoint, RejectedCheckpointReason } from '../store/block_store.js';
import type { ArchiverDataStores } from '../store/data_stores.js';
import type { ArchiverDataStoreUpdater } from './data_store_updater.js';
import type { ArchiverInstrumentation } from './instrumentation.js';
import { PendingChainValidationTracker } from './pending_chain_validation_tracker.js';
import { validateCheckpointAttestationsFromCalldata } from './validation.js';

/** A checkpoint observed in L1 calldata this iteration, whether ingested or rejected. */
export type SeenCheckpoint = Pick<RejectedCheckpoint, 'checkpointNumber' | 'l1'>;

/** How the checkpoint L1 published relates to the locally proposed checkpoint of the same number, if any. */
type ProposedCheckpointMatch =
  | { kind: 'promote'; checkpoint: PublishedCheckpoint }
  | { kind: 'evict'; fromCheckpointNumber: CheckpointNumber }
  | { kind: 'none' };

/**
 * Everything one batch decided before it is persisted: what to add, what to promote or evict, and the status to
 * persist. Screening has already recorded the batch's rejected checkpoints by then.
 */
type BatchPlan = {
  /** Accepted checkpoints in L1 order, blob-fetched or promoted. Drives metrics and logs. */
  published: PublishedCheckpoint[];
  /** The accepted checkpoints to persist from their L1 payloads (`published` minus the promoted one). */
  toAdd: PublishedCheckpoint[];
  /** The promoted checkpoint, when the match was a promotion and the checkpoint passed screening. */
  promoted: PublishedCheckpoint | undefined;
  /** First proposed checkpoint to evict, when the local proposed copy diverged from L1's. */
  evictProposedFrom: CheckpointNumber | undefined;
  /** The pending chain validation status to persist, if it moved this iteration. */
  validationUpdate: ValidateCheckpointResult | undefined;
  /** The batch's last checkpoint on L1, whether accepted or rejected. */
  lastSeenCheckpoint: SeenCheckpoint;
};

/** Collaborators the checkpoint ingestor shares with the L1 synchronizer. */
export type CheckpointIngestorDeps = {
  rollup: RollupContract;
  publicClient: ViemPublicClient;
  debugClient: ViemPublicDebugClient;
  blobClient: BlobClientInterface;
  epochCache: EpochCache;
  stores: ArchiverDataStores;
  updater: ArchiverDataStoreUpdater;
  events: ArchiverEmitter;
  instrumentation: ArchiverInstrumentation;
  l1Constants: L1RollupConstants;
  tracer: Tracer;
  log: Logger;
};

/** Ingestion settings, read on every pass so config updates apply to the next one. */
export type CheckpointIngestorOptions = {
  batchSizeInL1Blocks: bigint;
  skipValidateCheckpointAttestations: boolean;
  skipPromoteProposedCheckpointDuringL1Sync: boolean;
};

/**
 * Ingests the checkpoints L1 published in a range of L1 blocks: retrieves their calldata in batches, screens
 * attestations and rejected ancestry from calldata alone, promotes a matching locally proposed checkpoint instead of
 * fetching its blobs, fetches blobs for the rest and persists each batch. It rewinds the L1 sync point when a batch
 * turns out not to be consecutive with the stored chain, and never leaves it past where a batch started if the batch
 * fails before it is persisted.
 */
export class CheckpointIngestor {
  constructor(
    private readonly deps: CheckpointIngestorDeps,
    private readonly getOptions: () => CheckpointIngestorOptions,
  ) {}

  /** Ingests every checkpoint published in the L1 block range (from, to], batch by batch, in L1 order. */
  public async ingest(
    from: bigint,
    to: bigint,
    opts: { initialSyncComplete: boolean; initialValidationStatus: ValidateCheckpointResult | undefined },
  ): Promise<{ blocksAdded: L2Block[]; lastSeenCheckpoint: SeenCheckpoint | undefined }> {
    const validation = new PendingChainValidationTracker(opts.initialValidationStatus);
    const blocksAdded: L2Block[] = [];
    let lastSeenCheckpoint: SeenCheckpoint | undefined;

    // Retrieve checkpoints in batches. Each batch is estimated to accommodate up to 'blockBatchSize' L1 blocks,
    // computed using the L2 block time vs the L1 block time.
    let searchStartBlock: bigint = from;
    let searchEndBlock: bigint = from;
    do {
      [searchStartBlock, searchEndBlock] = this.nextRange(searchEndBlock, to);
      const calldataCheckpoints = await this.retrieveCalldata(searchStartBlock, searchEndBlock);
      if (calldataCheckpoints.length === 0) {
        continue;
      }
      const { plan, added } = await this.ingestBatch(
        calldataCheckpoints,
        { searchStartBlock, searchEndBlock },
        validation,
        opts.initialSyncComplete,
      );
      blocksAdded.push(...added);
      lastSeenCheckpoint = plan.lastSeenCheckpoint;
    } while (searchEndBlock < to);

    return { blocksAdded, lastSeenCheckpoint };
  }

  private getSignatureContext(): CoordinationSignatureContext {
    return {
      chainId: this.deps.publicClient.chain.id,
      rollupAddress: EthAddress.fromString(this.deps.rollup.address),
    };
  }

  private nextRange(end: bigint, limit: bigint): [bigint, bigint] {
    const nextStart = end + 1n;
    const nextEnd = nextStart + this.getOptions().batchSizeInL1Blocks;
    if (nextEnd > limit) {
      return [nextStart, limit];
    }
    return [nextStart, nextEnd];
  }

  /**
   * Retrieves the calldata of the checkpoints published in an L1 block range, sorted by L1 block. Blobs are not
   * fetched yet, since we may be able to just get that data out of the proposed chain.
   */
  private async retrieveCalldata(
    searchStartBlock: bigint,
    searchEndBlock: bigint,
  ): Promise<RetrievedCheckpointFromCalldata[]> {
    this.deps.log.trace(`Retrieving checkpoints from L1 block ${searchStartBlock} to ${searchEndBlock}`);

    const calldataCheckpoints = await execInSpan(
      this.deps.tracer,
      'Archiver.retrieveCheckpointCalldataFromRollup',
      () =>
        retrieveCheckpointCalldataFromRollup(
          this.deps.rollup,
          this.deps.publicClient,
          this.deps.debugClient,
          searchStartBlock, // TODO(palla/reorg): If the L2 reorg was due to an L1 reorg, we need to start search earlier
          searchEndBlock,
          this.deps.instrumentation,
          this.deps.log,
        ),
    );

    if (calldataCheckpoints.length === 0) {
      // We are not calling `setBlockSynchedL1BlockNumber` because it may cause sync issues if based off infura.
      // See further details in the TODO(#8621) comment in ArchiverL1Synchronizer.reconcileCheckpointedChain.
      this.deps.log.trace(`Retrieved no new checkpoints from L1 block ${searchStartBlock} to ${searchEndBlock}`);
      return [];
    }

    this.deps.log.debug(
      `Retrieved ${calldataCheckpoints.length} new checkpoint calldata between L1 blocks ${searchStartBlock} and ${searchEndBlock}`,
      {
        lastProcessedCheckpoint: calldataCheckpoints[calldataCheckpoints.length - 1].l1,
        searchStartBlock,
        searchEndBlock,
      },
    );
    return calldataCheckpoints;
  }

  /**
   * Plans and persists one non-empty batch of retrieved checkpoints.
   *
   * Screening records rejected checkpoints as it goes, and each such write advances the L1 sync point past the
   * rejected checkpoint's L1 block before the batch's valid checkpoints are persisted. If anything in the batch
   * throws before the batch is persisted, the sync point is restored to where it stood before the batch, so the next
   * iteration processes the whole batch again instead of skipping its valid checkpoints. Once the batch is persisted
   * the sync point is left alone: replaying it would refetch blobs for checkpoints already stored, including promoted
   * ones this node never fetched blobs for, and stall if those blobs are unavailable.
   */
  private async ingestBatch(
    calldataCheckpoints: RetrievedCheckpointFromCalldata[],
    range: { searchStartBlock: bigint; searchEndBlock: bigint },
    validation: PendingChainValidationTracker,
    initialSyncComplete: boolean,
  ): Promise<{ plan: BatchPlan; added: L2Block[] }> {
    const syncPointBeforeBatch = await this.deps.stores.blocks.getSynchedL1BlockNumber();
    const progress = { persisted: false };
    try {
      const plan = await this.planBatch(calldataCheckpoints, validation, initialSyncComplete);
      const added = await this.persistBatch(plan, progress);
      this.logDownloaded(plan.published);
      return { plan, added };
    } catch (err) {
      await this.restoreSyncPointAfterFailedBatch(syncPointBeforeBatch, range, progress);
      throw err;
    }
  }

  /**
   * Decides everything about a batch before touching the store, other than recording rejected checkpoints. The
   * proposed-copy lookup runs on the last checkpoint before screening, so a diverging local copy is evicted (and its
   * equivocation reported) even when L1's checkpoint is then rejected, and a matching copy whose L1 checkpoint is
   * rejected is not promoted.
   */
  private async planBatch(
    calldataCheckpoints: RetrievedCheckpointFromCalldata[],
    validation: PendingChainValidationTracker,
    initialSyncComplete: boolean,
  ): Promise<BatchPlan> {
    // Check if the last checkpoint matches a local pending entry (so we can skip blob fetch).
    // We only check the last one; if it matches, the blob fetch is skipped for that entry.
    // TODO(palla/pipelining): We may have more than a single checkpoint to promote
    const lastCalldataCheckpoint = calldataCheckpoints[calldataCheckpoints.length - 1];
    const match = await this.matchProposedCheckpoint(lastCalldataCheckpoint);
    const checkpointToPromote = match.kind === 'promote' ? match.checkpoint : undefined;

    const checkpointsToIngest = await this.screen(calldataCheckpoints, validation);
    const published = await this.buildPublished(checkpointsToIngest, checkpointToPromote, initialSyncComplete);

    // Split valid checkpoints: the promoted one (if any) is persisted via the proposed-promotion path,
    // the rest via addCheckpoints. Both paths run within the same store transaction for atomicity.
    const [[promoted], toAdd] = partition(
      published,
      c => c.checkpoint.number === checkpointToPromote?.checkpoint.number,
    );

    return {
      published,
      toAdd,
      promoted,
      evictProposedFrom: match.kind === 'evict' ? match.fromCheckpointNumber : undefined,
      validationUpdate: validation.update,
      // The last checkpoint seen on L1 this batch (valid or rejected), tracked from calldata since
      // rejected checkpoints are no longer built into PublishedCheckpoints.
      lastSeenCheckpoint: lastCalldataCheckpoint,
    };
  }

  /**
   * Validate attestations from CALLDATA before fetching any blobs. A checkpoint with invalid
   * attestations (or one descending from a rejected ancestor) is rejected here without fetching its
   * blobs, so a malformed blob does not throw during decode before the rejection path runs and
   * stall sync. The signed consensus payload (header, archive root, fee asset price
   * modifier) is fully available from calldata.
   *
   * Rejected checkpoints are recorded as they are found, outside the transaction that persists the batch, so a later
   * checkpoint in the same batch can find its rejected ancestor. Each record advances the L1 sync point past it.
   * Returns the accepted checkpoints in L1 order.
   */
  private async screen(
    calldataCheckpoints: RetrievedCheckpointFromCalldata[],
    validation: PendingChainValidationTracker,
  ): Promise<RetrievedCheckpointFromCalldata[]> {
    const checkpointsToIngest: RetrievedCheckpointFromCalldata[] = [];

    for (const calldataCheckpoint of calldataCheckpoints) {
      // Check the attestations uploaded by the publisher to L1 are correct.
      // Rollup contract does not validate attestations to save on gas, so this
      // falls on the nodes to verify offchain and skip those checkpoints.
      const validationResult = this.getOptions().skipValidateCheckpointAttestations
        ? { valid: true as const }
        : await validateCheckpointAttestationsFromCalldata(
            calldataCheckpoint,
            this.deps.epochCache,
            this.deps.l1Constants,
            this.getSignatureContext(),
            this.deps.log,
          );

      // Also skip the checkpoint if it builds on a previously-rejected ancestor. Without
      // this, addCheckpoints would throw InitialCheckpointNumberNotSequentialError when the
      // ancestor was skipped earlier (e.g. due to invalid attestations), the catch handler
      // would roll back the L1 sync point, and the next iteration would re-fetch and re-throw.
      const rejectedAncestor = await this.deps.stores.blocks.getRejectedCheckpointByArchiveRoot(
        calldataCheckpoint.header.lastArchiveRoot,
      );

      validation.observe(validationResult, { hasRejectedAncestor: rejectedAncestor !== undefined });

      if (!validationResult.valid) {
        this.deps.log.warn(`Skipping checkpoint ${calldataCheckpoint.checkpointNumber} due to invalid attestations`, {
          checkpointNumber: calldataCheckpoint.checkpointNumber,
          l1BlockNumber: calldataCheckpoint.l1.blockNumber,
          ...pick(validationResult, 'reason'),
        });

        // Emit event for invalid checkpoint detection
        this.deps.events.emit(L2BlockSourceEvents.InvalidAttestationsCheckpointDetected, {
          type: L2BlockSourceEvents.InvalidAttestationsCheckpointDetected,
          validationResult,
        });

        // Persist a rejected-ancestor entry so any later checkpoint that builds on this one
        // is detected and skipped (rather than tripping the addCheckpoints consecutive-number
        // check and causing the sync point to roll back in a loop).
        await this.recordRejected(calldataCheckpoint, 'invalid-attestations');

        continue;
      }

      if (rejectedAncestor) {
        const descendantInfo: CheckpointInfo = {
          archive: calldataCheckpoint.archiveRoot,
          lastArchive: calldataCheckpoint.header.lastArchiveRoot,
          slotNumber: calldataCheckpoint.header.slotNumber,
          checkpointNumber: calldataCheckpoint.checkpointNumber,
          timestamp: calldataCheckpoint.header.timestamp,
        };
        this.deps.log.warn(
          `Skipping checkpoint ${calldataCheckpoint.checkpointNumber} as it is a descendant of ` +
            `rejected checkpoint ${rejectedAncestor.checkpointNumber} (${rejectedAncestor.reason})`,
          {
            checkpointNumber: calldataCheckpoint.checkpointNumber,
            l1BlockNumber: calldataCheckpoint.l1.blockNumber,
            l1BlockHash: calldataCheckpoint.l1.blockHash,
            ancestorCheckpointNumber: rejectedAncestor.checkpointNumber,
            ancestorArchiveRoot: rejectedAncestor.archiveRoot.toString(),
            ancestorReason: rejectedAncestor.reason,
          },
        );

        this.deps.events.emit(L2BlockSourceEvents.DescendentOfInvalidAttestationsCheckpointDetected, {
          type: L2BlockSourceEvents.DescendentOfInvalidAttestationsCheckpointDetected,
          checkpoint: descendantInfo,
          ancestorArchiveRoot: rejectedAncestor.archiveRoot,
          ancestorCheckpointNumber: rejectedAncestor.checkpointNumber,
        });

        // Persist this chainpoint as rejected as well, so we can construct a chain of
        // skipped checkpoints starting from the first one with invalid attestations.
        await this.recordRejected(calldataCheckpoint, 'descends-from-invalid-attestations');

        continue;
      }

      checkpointsToIngest.push(calldataCheckpoint);
    }

    return checkpointsToIngest;
  }

  private recordRejected(calldataCheckpoint: RetrievedCheckpointFromCalldata, reason: RejectedCheckpointReason) {
    return this.deps.stores.blocks.addRejectedCheckpoint({
      checkpointNumber: calldataCheckpoint.checkpointNumber,
      archiveRoot: calldataCheckpoint.archiveRoot,
      parentArchiveRoot: calldataCheckpoint.header.lastArchiveRoot,
      slotNumber: calldataCheckpoint.header.slotNumber,
      l1: calldataCheckpoint.l1,
      reason,
    });
  }

  /** Builds the published checkpoints for the accepted ones, in L1 order, fetching blobs for all but the promoted one. */
  private async buildPublished(
    checkpointsToIngest: RetrievedCheckpointFromCalldata[],
    checkpointToPromote: PublishedCheckpoint | undefined,
    initialSyncComplete: boolean,
  ): Promise<PublishedCheckpoint[]> {
    // Fetch blobs in parallel only for the surviving (attestation-valid, non-descendant) checkpoints,
    // then build the full published checkpoints. The last calldata checkpoint may be promotable from a
    // local proposed block (checkpointToPromote), in which case it carries no blob to fetch. A missing or
    // undecodable blob throws and propagates, and the batch guard restores the L1 sync point so the fetch is retried.
    const toFetchBlobs = checkpointToPromote
      ? checkpointsToIngest.filter(c => c.checkpointNumber !== checkpointToPromote.checkpoint.number)
      : checkpointsToIngest;
    const blobFetched = await asyncPool(10, toFetchBlobs, async checkpoint =>
      retrievedToPublishedCheckpoint({
        ...checkpoint,
        checkpointBlobData: await getCheckpointBlobDataFromBlobs(
          this.deps.blobClient,
          checkpoint.l1.blockHash,
          checkpoint.blobHashes,
          checkpoint.checkpointNumber,
          this.deps.log,
          !initialSyncComplete,
          checkpoint.parentBeaconBlockRoot,
          checkpoint.l1.timestamp,
        ),
      }),
    );

    // Index the built checkpoints by number so we can ingest them in calldata order, slotting in the
    // promoted checkpoint (built from a local proposed block rather than blobs).
    const publishedByNumber = new Map(
      blobFetched.map(publishedCheckpoint => [publishedCheckpoint.checkpoint.number, publishedCheckpoint]),
    );
    if (checkpointToPromote) {
      publishedByNumber.set(checkpointToPromote.checkpoint.number, checkpointToPromote);
    }

    const validCheckpoints: PublishedCheckpoint[] = [];
    for (const calldataCheckpoint of checkpointsToIngest) {
      const published = publishedByNumber.get(calldataCheckpoint.checkpointNumber)!;

      validCheckpoints.push(published);
      this.deps.log.debug(
        `Ingesting new checkpoint ${published.checkpoint.number} with ${published.checkpoint.blocks.length} blocks`,
        {
          checkpointHash: published.checkpoint.hash(),
          l1BlockNumber: published.l1.blockNumber,
          ...published.checkpoint.header.toInspect(),
          blocks: published.checkpoint.blocks.map(b => b.getStats()),
        },
      );
    }

    for (const published of validCheckpoints) {
      this.deps.instrumentation.processCheckpointL1Timing({
        slotNumber: published.checkpoint.header.slotNumber,
        l1Timestamp: published.l1.timestamp,
        l1Constants: this.deps.l1Constants,
      });
    }

    return validCheckpoints;
  }

  /**
   * Persists a planned batch in one store transaction, then reports its blocks and any local blocks it pruned.
   * Marks `progress.persisted` once `addCheckpoints` has returned, which is after its transaction committed and the
   * frontier cache refreshed, so a failed refresh still counts as not persisted. Rewinds the L1 sync point if the batch
   * is not consecutive with the stored chain. Returns the blocks persisted from L1 payloads.
   */
  private async persistBatch(plan: BatchPlan, progress: { persisted: boolean }): Promise<L2Block[]> {
    try {
      const [processDuration, result] = await elapsed(() =>
        execInSpan(this.deps.tracer, 'Archiver.addCheckpoints', async () => {
          const addResult = await this.deps.updater.addCheckpoints(
            plan.toAdd,
            plan.validationUpdate,
            plan.promoted,
            plan.evictProposedFrom,
          );
          // Set before the span wrappers finish, so a throw while closing the span doesn't count as unpersisted.
          progress.persisted = true;
          return addResult;
        }),
      );

      if (plan.published.length > 0) {
        this.deps.instrumentation.processNewCheckpointedBlocks(
          processDuration / plan.published.length,
          plan.published.flatMap(c => c.checkpoint.blocks),
        );
      }

      // Record blocks newly fetched from L1 checkpoint payloads as added. The promoted checkpoint (if any) is
      // excluded: its blocks were already in local archiver storage (added via the proposed-block path) so the
      // block stream does not need them re-downloaded.
      const added = plan.toAdd.flatMap(c => c.checkpoint.blocks);

      // If blocks were pruned due to conflict with L1 checkpoints, emit event
      if (result.prunedBlocks && result.prunedBlocks.length > 0) {
        const prunedCheckpointNumber = result.prunedBlocks[0].checkpointNumber;
        const prunedSlotNumber = result.prunedBlocks[0].header.globalVariables.slotNumber;

        this.deps.log.info(
          `Pruned ${result.prunedBlocks.length} mismatching blocks for checkpoint ${prunedCheckpointNumber}`,
          { prunedBlocks: result.prunedBlocks.map(b => b.toBlockInfo()), prunedSlotNumber, prunedCheckpointNumber },
        );

        this.deps.instrumentation.recordPrune('l1_conflict');

        // Emit event for listening services to react to the prune.
        // Note: slotNumber comes from the first pruned block. If pruned blocks theoretically spanned multiple slots,
        // only one slot number would be reported (though in practice all blocks in a checkpoint span a single slot).
        this.deps.events.emit(L2BlockSourceEvents.L2PruneUncheckpointed, {
          type: L2BlockSourceEvents.L2PruneUncheckpointed,
          slotNumber: prunedSlotNumber,
          blocks: result.prunedBlocks,
        });
      }

      return added;
    } catch (err) {
      if (err instanceof InitialCheckpointNumberNotSequentialError) {
        await this.rewindSyncPointAfterGap(err);
      }
      throw err;
    }
  }

  /**
   * Moves the L1 sync point back to the previous checkpoint's L1 block (falling back to the finalized checkpoint's,
   * then to the rollup's start block), so the next iteration fetches the checkpoints missing before the batch.
   */
  private async rewindSyncPointAfterGap(err: InitialCheckpointNumberNotSequentialError): Promise<void> {
    const { previousCheckpointNumber, newCheckpointNumber } = err;
    const previousCheckpoint = previousCheckpointNumber
      ? await this.deps.stores.blocks.getCheckpointData(CheckpointNumber(previousCheckpointNumber))
      : undefined;
    const lastFinalizedCheckpoint = await this.deps.stores.blocks.getCheckpointData(
      await this.deps.stores.blocks.getFinalizedCheckpointNumber(),
    );
    const updatedL1SyncPoint =
      previousCheckpoint?.l1.blockNumber ??
      lastFinalizedCheckpoint?.l1.blockNumber ??
      this.deps.l1Constants.l1StartBlock;
    await this.deps.stores.blocks.setSynchedL1BlockNumber(updatedL1SyncPoint);
    this.deps.log.warn(
      `Attempting to insert checkpoint ${newCheckpointNumber} with previous block ${previousCheckpointNumber}. Rolling back L1 sync point to ${updatedL1SyncPoint} to try and fetch the missing blocks.`,
      {
        previousCheckpointNumber,
        previousCheckpoint: previousCheckpoint?.header.toInspect(),
        lastFinalizedCheckpoint: lastFinalizedCheckpoint?.header.toInspect(),
        l1StartBlock: this.deps.l1Constants.l1StartBlock,
        newCheckpointNumber,
        updatedL1SyncPoint,
      },
    );
  }

  /** Lowers the L1 sync point back to where it stood before a failed batch, unless the batch was persisted. */
  private async restoreSyncPointAfterFailedBatch(
    syncPointBeforeBatch: bigint | undefined,
    { searchStartBlock, searchEndBlock }: { searchStartBlock: bigint; searchEndBlock: bigint },
    progress: { persisted: boolean },
  ): Promise<void> {
    const restoreTo = syncPointBeforeBatch ?? this.deps.l1Constants.l1StartBlock;
    const currentSyncPoint = await this.deps.stores.blocks.getSynchedL1BlockNumber();
    // Only ever lower it, so a deeper rewind made while handling the error (e.g. on a checkpoint gap) is kept.
    if (!progress.persisted && currentSyncPoint !== undefined && currentSyncPoint > restoreTo) {
      this.deps.log.warn(`Restoring L1 sync point to ${restoreTo} after failing to process checkpoints`, {
        currentSyncPoint,
        restoreTo,
        searchStartBlock,
        searchEndBlock,
      });
      await this.deps.stores.blocks.setSynchedL1BlockNumber(restoreTo);
    }
  }

  private logDownloaded(published: PublishedCheckpoint[]): void {
    for (const checkpoint of published) {
      this.deps.log.info(`Downloaded checkpoint ${checkpoint.checkpoint.number}`, {
        checkpointHash: checkpoint.checkpoint.hash(),
        checkpointNumber: checkpoint.checkpoint.number,
        blockCount: checkpoint.checkpoint.blocks.length,
        txCount: checkpoint.checkpoint.blocks.reduce((acc, b) => acc + b.body.txEffects.length, 0),
        header: checkpoint.checkpoint.header.toInspect(),
        archiveRoot: checkpoint.checkpoint.archive.root.toString(),
        archiveNextLeafIndex: checkpoint.checkpoint.archive.nextAvailableLeafIndex,
      });
    }
  }

  /**
   * Checks if a specific checkpoint matches a local pending entry, and if so, loads local data to build
   * a synthetic published checkpoint (skipping blob fetch), returned as a `promote` match.
   *
   * Returns an `evict` match when the L1 checkpoint does NOT match local pending data for that number, so the
   * caller can evict the entire pending suffix >= fromCheckpointNumber (those entries chain off the now-invalid
   * local state) within the same addCheckpoints transaction.
   */
  private async matchProposedCheckpoint(
    calldataCheckpoint: RetrievedCheckpointFromCalldata,
  ): Promise<ProposedCheckpointMatch> {
    if (this.getOptions().skipPromoteProposedCheckpointDuringL1Sync) {
      return { kind: 'none' };
    }

    // Look up the specific pending entry for the checkpoint being mined, not just the tip
    const proposed = await this.deps.stores.blocks.getProposedCheckpointByNumber(calldataCheckpoint.checkpointNumber);
    if (!proposed) {
      return { kind: 'none' };
    }

    if (
      !proposed.header.equals(calldataCheckpoint.header) ||
      !proposed.archive.root.equals(calldataCheckpoint.archiveRoot) ||
      proposed.feeAssetPriceModifier !== calldataCheckpoint.feeAssetPriceModifier
    ) {
      this.deps.log.warn(
        `Local proposed checkpoint ${proposed.checkpointNumber} does not match checkpoint retrieved from L1, overriding with L1 data`,
        {
          proposedCheckpointNumber: proposed.checkpointNumber,
          proposedHeader: proposed.header.toInspect(),
          proposedArchiveRoot: proposed.archive.root.toString(),
          proposedFeeAssetPriceModifier: proposed.feeAssetPriceModifier.toString(),
          calldataCheckpointNumber: calldataCheckpoint.checkpointNumber,
          calldataHeader: calldataCheckpoint.header.toInspect(),
          calldataArchiveRoot: calldataCheckpoint.archiveRoot.toString(),
          calldataFeeAssetPriceModifier: calldataCheckpoint.feeAssetPriceModifier.toString(),
        },
      );
      // Both the locally-proposed checkpoint and the L1-confirmed one are signed by the
      // slot proposer; emit a divergence event so the slasher can attribute equivocation.
      // Only emit when the slots match — uncheckpointed entries are pruned above so this
      // should always hold, but guard defensively to avoid mis-attributing a slash.
      if (proposed.header.slotNumber === calldataCheckpoint.header.slotNumber) {
        this.deps.events.emit(L2BlockSourceEvents.CheckpointEquivocationDetected, {
          type: L2BlockSourceEvents.CheckpointEquivocationDetected,
          slotNumber: calldataCheckpoint.header.slotNumber,
          checkpointNumber: calldataCheckpoint.checkpointNumber,
          l1ArchiveRoot: calldataCheckpoint.archiveRoot,
          proposedArchiveRoot: proposed.archive.root,
        });
      }
      // Return a divergence signal so the caller can evict pending >= this number
      return { kind: 'evict', fromCheckpointNumber: proposed.checkpointNumber };
    }

    this.deps.log.debug(
      `Building published checkpoint from proposed ${calldataCheckpoint.checkpointNumber} (skipping blob fetch)`,
      { proposedHeader: proposed.header.toInspect(), proposedArchiveRoot: proposed.archive.root.toString() },
    );

    const blocks = await this.deps.stores.blocks.getBlocks({
      from: BlockNumber(proposed.startBlock),
      limit: proposed.blockCount,
    });
    if (blocks.length !== proposed.blockCount) {
      this.deps.log.warn(
        `Local proposed checkpoint ${proposed.checkpointNumber} has wrong block count (expected ${proposed.blockCount} blocks starting at ${proposed.startBlock} but got ${blocks.length})`,
        {
          proposedCheckpointNumber: proposed.checkpointNumber,
          proposedStartBlock: proposed.startBlock,
          proposedBlockCount: proposed.blockCount,
          retrievedBlocks: blocks.map(b => b.number),
        },
      );
      return { kind: 'none' };
    }

    const checkpoint = Checkpoint.from({
      archive: proposed.archive,
      header: proposed.header,
      blocks,
      number: proposed.checkpointNumber,
      feeAssetPriceModifier: proposed.feeAssetPriceModifier,
    });
    const promotedCheckpoint = PublishedCheckpoint.from({
      checkpoint,
      l1: calldataCheckpoint.l1,
      attestations: calldataCheckpoint.attestations,
      verbatimAttestations: calldataCheckpoint.verbatimAttestations,
    });
    this.deps.instrumentation.processCheckpointPromoted();

    return { kind: 'promote', checkpoint: promotedCheckpoint };
  }
}
