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

import { CheckpointAttestationsDecodeError } from '../errors.js';

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

/** The subset of a calldata-only checkpoint needed to validate its committee attestations. */
export type CalldataCheckpointForAttestations = {
  checkpointNumber: CheckpointNumber;
  archiveRoot: Fr;
  feeAssetPriceModifier: bigint;
  header: CheckpointHeader;
  /** The exact packed attestations tuple from L1 calldata, carried verbatim for byte-faithful invalidation. */
  verbatimAttestations: ViemCommitteeAttestations;
};

/** A checkpoint's attestations decoded for its epoch committee, and their validation result. */
export type ResolvedCheckpointAttestations = {
  /** Empty if the epoch has an open escape hatch or no committee. */
  attestations: CommitteeAttestation[];
  validationResult: ValidateCheckpointResult;
};

/**
 * Decodes and validates the attestations of a checkpoint from L1 calldata only, so an invalid checkpoint can be
 * rejected before its blobs are fetched. The tuple is decoded against the epoch's committee size, and not at all
 * during an escape hatch, where the proposer may post an arbitrary tuple.
 *
 * @throws CheckpointAttestationsDecodeError if the tuple does not decode for the epoch committee.
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
  // Read the hatch flag from the same cache entry as the committee, so both come from one snapshot.
  const { committee, seed, isEscapeHatchOpen } = await epochCache.getCommitteeForEpoch(epoch);

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
 * independent of whether the checkpoint's blocks have been decoded from blobs. Returns true if the
 * attestations are valid and sufficient, false otherwise.
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
  const { committee, seed, isEscapeHatchOpen } = await epochCache.getCommitteeForEpoch(epoch);

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

  return validateAttestationsAgainstCommittee(
    payload,
    attestations,
    verbatimAttestations,
    checkpointInfo,
    { committee, seed, epoch },
    logger,
  );
}

/** Validates decoded attestations against a known, non-empty epoch committee. */
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
