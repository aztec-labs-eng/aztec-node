import type { CalldataRetriever } from '@aztec-labs/archiver';
import type { RollupContract, ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import type { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';

/**
 * Supplies the packed `CommitteeAttestations` tuple exactly as it was posted to L1, byte for byte.
 *
 * The rollup stores `keccak256(abi.encode(attestations))` at propose time and re-checks it when an epoch proof
 * is submitted, so the tuple can never be re-derived from decoded attestations: bitmap bits past the committee
 * size, a yParity recovery byte and an all-zero signature slot all survive the hash but not a decode/repack
 * round trip.
 */
export interface VerbatimAttestationsSource {
  /** Returns the packed tuple the given checkpoint was proposed with. Throws if it cannot be recovered. */
  getVerbatimAttestations(checkpointNumber: CheckpointNumber): Promise<ViemCommitteeAttestations>;
}

/** Raised when the propose calldata for a checkpoint cannot be recovered from L1. */
export class VerbatimAttestationsUnavailableError extends Error {
  constructor(
    public readonly checkpointNumber: CheckpointNumber,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Cannot recover the attestations posted for checkpoint ${checkpointNumber}: ${reason}`, options);
    this.name = 'VerbatimAttestationsUnavailableError';
  }
}

export type VerbatimAttestationsDeps = {
  /** Locates the L1 block the checkpoint was proposed in. */
  l2BlockSource: Pick<L2BlockSource, 'getCheckpoint'>;
  rollupContract: Pick<RollupContract, 'getCheckpoint' | 'getCheckpointProposedEvents'>;
  /** Decodes the propose calldata and refuses to return a tuple that does not hash to the expected value. */
  calldataRetriever: Pick<CalldataRetriever, 'getCheckpointFromRollupTx'>;
  bindings?: LoggerBindings;
};

/**
 * Re-reads the propose calldata from L1 to recover a checkpoint's attestations tuple verbatim. The
 * `CalldataRetriever` verifies the recovered bytes against the `attestationsHash` the rollup stored, so a tuple
 * that comes back is guaranteed to be the one the rollup will accept.
 */
export class L1VerbatimAttestationsSource implements VerbatimAttestationsSource {
  private readonly log: Logger;

  constructor(private readonly deps: VerbatimAttestationsDeps) {
    this.log = createLogger('prover-node:verbatim-attestations', deps.bindings);
  }

  public async getVerbatimAttestations(checkpointNumber: CheckpointNumber): Promise<ViemCommitteeAttestations> {
    const published = await this.deps.l2BlockSource.getCheckpoint({ number: checkpointNumber });
    if (!published) {
      throw new VerbatimAttestationsUnavailableError(checkpointNumber, 'checkpoint not found in the block source');
    }

    const { attestationsHash, payloadDigest } = await this.deps.rollupContract.getCheckpoint(checkpointNumber);

    // The archiver records the L1 block the checkpoint was proposed in, so this is a single-block log query
    // rather than a range sweep.
    const l1BlockNumber = published.l1.blockNumber;
    const events = await this.deps.rollupContract.getCheckpointProposedEvents(l1BlockNumber, l1BlockNumber);
    const event = events.find(
      e => e.args.checkpointNumber === checkpointNumber && e.args.attestationsHash.equals(attestationsHash),
    );
    if (!event) {
      throw new VerbatimAttestationsUnavailableError(
        checkpointNumber,
        `no CheckpointProposed event matching attestations hash ${attestationsHash.toString()} on L1 block ${l1BlockNumber}`,
      );
    }

    let verbatimAttestations: ViemCommitteeAttestations;
    try {
      ({ verbatimAttestations } = await this.deps.calldataRetriever.getCheckpointFromRollupTx(
        event.l1TransactionHash,
        event.args.versionedBlobHashes,
        checkpointNumber,
        { attestationsHash: attestationsHash.toString(), payloadDigest: payloadDigest.toString() },
      ));
    } catch (err) {
      throw new VerbatimAttestationsUnavailableError(
        checkpointNumber,
        `failed to decode the propose calldata of ${event.l1TransactionHash}`,
        { cause: err },
      );
    }

    this.log.debug(`Recovered verbatim attestations for checkpoint ${checkpointNumber}`, {
      checkpointNumber,
      l1BlockNumber,
      l1TransactionHash: event.l1TransactionHash,
      attestationsHash: attestationsHash.toString(),
    });

    return verbatimAttestations;
  }
}
