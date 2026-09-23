import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { type CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { compactArray } from '@aztec-labs/foundation/collection';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import {
  type AttestationInfo,
  CommitteeAttestation,
  type ValidateCheckpointNegativeResult,
  type ValidateCheckpointResult,
  getAttestationInfoFromPayload,
} from '@aztec-labs/stdlib/block';
import type { CheckpointInfo, PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import { type L1RollupConstants, computeQuorum, getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { ConsensusPayload, type CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';
import type { CheckpointHeader } from '@aztec-labs/stdlib/rollup';

import { CheckpointAttestationsDecodeError, EscapeHatchStatusUnknownError } from '../errors.js';

export type { ValidateCheckpointResult };

/**
 * Extracts attestation information from a published checkpoint.
 * Returns info for each attestation, preserving array indices.
 */
export function getAttestationInfoFromPublishedCheckpoint(
  { checkpoint, attestations }: PublishedCheckpoint,
  signatureContext: CoordinationSignatureContext,
): AttestationInfo[] {
  const payload = ConsensusPayload.fromCheckpoint(checkpoint, signatureContext);
  return getAttestationInfoFromPayload(payload, attestations);
}

/** The subset of a calldata-only checkpoint needed to resolve and validate its committee attestations. */
export type CalldataCheckpointForAttestations = {
  checkpointNumber: CheckpointNumber;
  archiveRoot: Fr;
  feeAssetPriceModifier: bigint;
  header: CheckpointHeader;
  /** The exact packed attestations tuple from L1 calldata, carried verbatim for byte-faithful invalidation. */
  verbatimAttestations: ViemCommitteeAttestations;
};

/** A checkpoint's packed attestations tuple interpreted against the committee of the epoch it belongs to. */
export type ResolvedCheckpointAttestations = {
  /**
   * The logical committee attestations of the checkpoint. Empty for a checkpoint whose epoch has an open
   * escape hatch or no committee at all: neither carries attestation semantics, and the tuple an escape-hatch
   * proposer posts need not decode as a committee at all.
   */
  attestations: CommitteeAttestation[];
  /** Whether the resolved attestations are valid and sufficient for the epoch committee. */
  validationResult: ValidateCheckpointResult;
};

/**
 * Interprets and validates the attestations of a checkpoint from L1 calldata only, without fetching or
 * decoding its blobs. The signed consensus payload (header, archive root, fee asset price modifier) is fully
 * available from calldata, so an invalid-attestation checkpoint can be rejected before any (possibly
 * malformed) blob is fetched and decoded.
 *
 * The epoch's attestation policy is resolved before any byte of the packed tuple is read: during an escape
 * hatch (or with no committee at all) the rollup accepts an arbitrary tuple that carries no attestations and
 * that a committee-sized decode would throw on, so the tuple is left packed and the logical attestation list
 * is empty. Otherwise the tuple is decoded to exactly the length of the committee recorded for that epoch --
 * not the rollup's current target committee size, which may have been reconfigured since.
 *
 * @throws CheckpointAttestationsDecodeError if a non-hatch checkpoint's tuple does not decode to its
 * committee's length. Its proposal hashes have already been verified at this point, so the tuple is the one
 * the rollup accepted and the failure is not a calldata-extraction mismatch.
 * @throws EscapeHatchStatusUnknownError if the epoch has a committee but its escape hatch status could not be
 * looked up, rather than judging a possibly arbitrary hatch tuple against that committee.
 */
export async function resolveCheckpointAttestationsFromCalldata(
  checkpoint: CalldataCheckpointForAttestations,
  epochCache: EpochCache,
  constants: Pick<L1RollupConstants, 'epochDuration'>,
  signatureContext: CoordinationSignatureContext,
  logger?: Logger,
): Promise<ResolvedCheckpointAttestations> {
  const slot = checkpoint.header.slotNumber;
  const epoch: EpochNumber = getEpochAtSlot(slot, constants);
  // The hatch flag comes out of the same epoch-cache entry as the committee: reading it back through
  // `isEscapeHatchOpen` would be a second lookup that a refresh can land between, pairing one snapshot's
  // committee with another's hatch status.
  const { committee, seed, isEscapeHatchOpen, isEscapeHatchStatusUnknown } =
    await epochCache.getCommitteeForEpoch(epoch);

  if (isEscapeHatchOpen) {
    logger?.warn(
      `Escape hatch open for epoch ${epoch} at slot ${slot}, skipping attestations of checkpoint ${checkpoint.checkpointNumber}`,
    );
    return { attestations: [], validationResult: { valid: true } };
  }

  if (!committee || committee.length === 0) {
    logger?.warn(
      `No committee found for epoch ${epoch} at slot ${slot}. Accepting checkpoint ${checkpoint.checkpointNumber} without validation.`,
    );
    return { attestations: [], validationResult: { valid: true } };
  }

  if (isEscapeHatchStatusUnknown) {
    throw new EscapeHatchStatusUnknownError(checkpoint.checkpointNumber, epoch);
  }

  let attestations: CommitteeAttestation[];
  try {
    attestations = CommitteeAttestation.fromPacked(checkpoint.verbatimAttestations, committee.length);
  } catch (err) {
    throw new CheckpointAttestationsDecodeError(checkpoint.checkpointNumber, epoch, committee.length, err);
  }

  const payload = new ConsensusPayload(
    checkpoint.header,
    checkpoint.archiveRoot,
    checkpoint.feeAssetPriceModifier,
    signatureContext,
  );
  const checkpointInfo: CheckpointInfo = {
    archive: checkpoint.archiveRoot,
    lastArchive: checkpoint.header.lastArchiveRoot,
    slotNumber: checkpoint.header.slotNumber,
    checkpointNumber: checkpoint.checkpointNumber,
    timestamp: checkpoint.header.timestamp,
  };

  const validationResult = validateAttestationsAgainstCommittee(
    payload,
    attestations,
    checkpoint.verbatimAttestations,
    checkpointInfo,
    { committee, seed, epoch },
    logger,
  );
  return { attestations, validationResult };
}

/**
 * Core attestation validation over a consensus payload, its attestations, and checkpoint metadata --
 * independent of whether the checkpoint's blocks have been decoded from blobs. Loads the committee of the
 * epoch the checkpoint falls in and skips validation entirely for an epoch with an open escape hatch or no
 * committee. Returns true if the attestations are valid and sufficient, false otherwise.
 */
export async function validateAttestations(
  payload: ConsensusPayload,
  attestations: CommitteeAttestation[],
  verbatimAttestations: ViemCommitteeAttestations,
  checkpointInfo: CheckpointInfo,
  epochCache: EpochCache,
  constants: Pick<L1RollupConstants, 'epochDuration'>,
  logger?: Logger,
): Promise<ValidateCheckpointResult> {
  const slot = payload.header.slotNumber;
  const epoch: EpochNumber = getEpochAtSlot(slot, constants);
  const { committee, seed, isEscapeHatchOpen, isEscapeHatchStatusUnknown } =
    await epochCache.getCommitteeForEpoch(epoch);

  if (isEscapeHatchOpen) {
    logger?.warn(`Escape hatch open for epoch ${epoch} at slot ${slot}, skipping checkpoint validation`);
    return { valid: true };
  }

  if (!committee || committee.length === 0) {
    logger?.warn(`No committee found for epoch ${epoch} at slot ${slot}. Accepting checkpoint without validation.`, {
      checkpointNumber: checkpointInfo.checkpointNumber,
      slot,
      epoch,
    });
    return { valid: true };
  }

  if (isEscapeHatchStatusUnknown) {
    throw new EscapeHatchStatusUnknownError(checkpointInfo.checkpointNumber, epoch);
  }

  return validateAttestationsAgainstCommittee(
    payload,
    attestations,
    verbatimAttestations,
    checkpointInfo,
    { committee, seed, epoch },
    logger,
  );
}

/**
 * Validates already-resolved attestations against a known epoch committee: every attestation must be signed
 * by (or name) the committee member at its own index, and enough of them must carry a signature to reach
 * quorum.
 */
function validateAttestationsAgainstCommittee(
  payload: ConsensusPayload,
  attestations: CommitteeAttestation[],
  verbatimAttestations: ViemCommitteeAttestations,
  checkpointInfo: CheckpointInfo,
  { committee, seed, epoch }: { committee: EthAddress[]; seed: bigint; epoch: EpochNumber },
  logger?: Logger,
): ValidateCheckpointResult {
  const attestorInfos = getAttestationInfoFromPayload(payload, attestations);
  const attestors = compactArray(attestorInfos.map(info => ('address' in info ? info.address : undefined)));
  const headerHash = payload.header.hash();
  const archiveRoot = payload.archive.toString();
  const slot = payload.header.slotNumber;
  const checkpointNumber = checkpointInfo.checkpointNumber;
  const logData = { checkpointNumber, slot, epoch, headerHash, archiveRoot };

  logger?.debug(`Validating attestations for checkpoint ${checkpointNumber} at slot ${slot} in epoch ${epoch}`, {
    committee: committee.map(member => member.toString()),
    recoveredAttestors: attestorInfos,
    postedAttestations: attestations.map(a => (a.address.isZero() ? a.signature : a.address).toString()),
    ...logData,
  });

  const requiredAttestationCount = computeQuorum(committee.length);

  const failedValidationResult = <TReason extends ValidateCheckpointNegativeResult['reason']>(reason: TReason) => ({
    valid: false as const,
    reason,
    checkpoint: checkpointInfo,
    committee,
    seed,
    epoch,
    attestors,
    attestations,
    verbatimAttestations,
  });

  for (let i = 0; i < attestorInfos.length; i++) {
    const info = attestorInfos[i];

    // Fail on invalid signatures (no address recovered)
    if (info.status === 'invalid-signature' || info.status === 'empty') {
      logger?.warn(`Attestation with empty or invalid signature at slot ${slot}`, {
        committee,
        invalidIndex: i,
        ...logData,
      });
      return { ...failedValidationResult('invalid-attestation'), invalidIndex: i };
    }

    // Check if the attestor at this index matches the committee member at the same index
    if (info.status === 'recovered-from-signature' || info.status === 'provided-as-address') {
      const signer = info.address.toString();
      const expectedCommitteeMember = committee[i]?.toString();

      if (!expectedCommitteeMember || signer !== expectedCommitteeMember) {
        logger?.warn(
          `Attestation at index ${i} from ${signer} does not match expected committee member ${expectedCommitteeMember} at slot ${slot}`,
          {
            committee,
            invalidIndex: i,
            ...logData,
          },
        );
        return { ...failedValidationResult('invalid-attestation'), invalidIndex: i };
      }
    }
  }

  const validAttestationCount = attestorInfos.filter(info => info.status === 'recovered-from-signature').length;
  if (validAttestationCount < requiredAttestationCount) {
    logger?.warn(`Insufficient attestations for checkpoint at slot ${slot}`, {
      requiredAttestations: requiredAttestationCount,
      actualAttestations: validAttestationCount,
      ...logData,
    });
    return failedValidationResult('insufficient-attestations');
  }

  logger?.debug(
    `Checkpoint attestations validated successfully for checkpoint ${checkpointNumber} at slot ${slot}`,
    logData,
  );
  return { valid: true };
}
