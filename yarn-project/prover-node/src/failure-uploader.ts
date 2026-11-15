import type { Archiver } from '@aztec-labs/archiver';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { CommitteeAttestationsAndSigners, type L2BlockSource } from '@aztec-labs/stdlib/block';
import type { Checkpoint } from '@aztec-labs/stdlib/checkpoint';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import type { WorldStateSynchronizer } from '@aztec-labs/stdlib/interfaces/server';
import type { DataStoreConfig } from '@aztec-labs/stdlib/kv-store';
import type { Tx } from '@aztec-labs/stdlib/tx';

import { uploadEpochProofFailure } from './actions/upload-epoch-proof-failure.js';
import type { CheckpointProver } from './job/checkpoint-prover.js';
import type { EpochProvingJobData } from './job/epoch-proving-job-data.js';

/** Where failure data is uploaded and what identifies the node's data in it. */
export type FailureUploadConfig = {
  /** Destination file store. Uploads are skipped when unset. */
  failedEpochStore: string | undefined;
} & Partial<Pick<DataStoreConfig, 'dataDirectory'> & Pick<ChainConfig, 'l1ChainId' | 'rollupVersion'>>;

export type FailureUploaderDeps = {
  l2BlockSource: L2BlockSource;
  worldState: WorldStateSynchronizer;
  config: FailureUploadConfig;
  bindings?: LoggerBindings;
};

/**
 * Uploads the data needed to re-run a failed proving attempt offline, together with a world-state and archiver
 * backup. Does nothing unless a failed-epoch store is configured.
 */
export class FailureUploader {
  private readonly log: Logger;

  constructor(private readonly deps: FailureUploaderDeps) {
    this.log = createLogger('prover-node:failure-uploader', deps.bindings);
  }

  /**
   * Uploads the proving data of an epoch whose full session failed, built from that session's checkpoint provers.
   * Returns the upload location, or undefined when nothing was uploaded.
   */
  public async uploadEpochFailure(id: string, checkpoints: readonly CheckpointProver[]): Promise<string | undefined> {
    if (!this.deps.config.failedEpochStore || checkpoints.length === 0) {
      return undefined;
    }
    return await this.upload(id, await buildProvingData(checkpoints));
  }

  /**
   * Uploads the proving data of a single failed checkpoint prover. A prover fails the same way for a genuine
   * proving fault and for a prune that removed its base block, so the archiver decides: a checkpoint that is no
   * longer canonical was pruned, and is not uploaded. Never throws.
   */
  public async uploadCheckpointFailure(prover: CheckpointProver): Promise<string | undefined> {
    if (!this.deps.config.failedEpochStore) {
      return undefined;
    }
    try {
      if (!(await this.isCheckpointCanonical(prover.checkpoint))) {
        this.log.debug(`Skipping checkpoint-failure upload for ${prover.id}: no longer canonical (pruned)`, {
          checkpointNumber: prover.checkpoint.number,
        });
        return undefined;
      }
      return await this.upload(prover.id, await buildProvingData([prover]));
    } catch (err) {
      this.log.error(`Error uploading checkpoint failure for ${prover.id}`, err);
      return undefined;
    }
  }

  /**
   * True if the archiver holds a block at the checkpoint's last block number with the checkpoint's archive root.
   * A prune leaves that block missing or replaced.
   */
  public async isCheckpointCanonical(checkpoint: Checkpoint): Promise<boolean> {
    const lastBlock = checkpoint.blocks.at(-1);
    if (!lastBlock) {
      return false;
    }
    const onChain = await this.deps.l2BlockSource.getBlock({ number: lastBlock.number });
    return !!onChain && onChain.archive.root.equals(checkpoint.archive.root);
  }

  private upload(id: string, data: EpochProvingJobData): Promise<string> {
    const { failedEpochStore, l1ChainId, rollupVersion, dataDirectory } = this.deps.config;
    if (!failedEpochStore || !dataDirectory || !l1ChainId || rollupVersion === undefined) {
      throw new Error('Uploading failure data requires a store, dataDirectory, l1ChainId and rollupVersion');
    }
    // The upload path already starts with the epoch number, so `id` only has to be unique within the epoch.
    return uploadEpochProofFailure(
      failedEpochStore,
      id,
      data,
      this.deps.l2BlockSource as Archiver,
      this.deps.worldState,
      { l1ChainId, rollupVersion, dataDirectory },
      this.log,
    );
  }
}

/**
 * Builds the data needed to re-run proving for a set of checkpoint provers. Includes every checkpoint whether or not
 * its block-level proving completed. The provers keep no transactions, so they are fetched again from the tx pool;
 * transactions the pool no longer holds are left out.
 */
export async function buildProvingData(checkpoints: readonly CheckpointProver[]): Promise<EpochProvingJobData> {
  if (checkpoints.length === 0) {
    throw new Error('Cannot build proving data from an empty checkpoint set');
  }
  const perCheckpoint = await Promise.all(checkpoints.map(async c => ({ c, txs: await c.getTxsForUpload() })));
  const txs = new Map<string, Tx>();
  const l1ToL2Messages: Record<number, Fr[]> = {};
  for (const { c, txs: checkpointTxs } of perCheckpoint) {
    for (const [hash, tx] of checkpointTxs) {
      txs.set(hash, tx);
    }
    l1ToL2Messages[c.checkpoint.number] = c.l1ToL2Messages;
  }
  return {
    epochNumber: checkpoints[0].epochNumber,
    checkpoints: checkpoints.map(c => c.checkpoint),
    txs,
    l1ToL2Messages,
    previousBlockHeader: checkpoints[0].previousBlockHeader,
    previousInboxRollingHash: checkpoints[0].previousInboxRollingHash,
    verbatimAttestations: CommitteeAttestationsAndSigners.packAttestations([]),
  };
}
