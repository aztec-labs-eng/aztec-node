import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { times } from '@aztec-labs/foundation/collection';
import { Secp256k1Signer, flipSignature } from '@aztec-labs/foundation/crypto/secp256k1-signer';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import {
  CommitteeAttestation,
  CommitteeAttestationsAndSigners,
  EthAddress,
  type ValidateCheckpointResult,
} from '@aztec-labs/stdlib/block';
import { Checkpoint, type PublishedCheckpoint } from '@aztec-labs/stdlib/checkpoint';
import type { L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import { ConsensusPayload, type CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';
import { TEST_COORDINATION_SIGNATURE_CONTEXT } from '@aztec-labs/stdlib/testing';
import { type MockProxy, mock } from 'jest-mock-extended';
import assert from 'node:assert';

import { CheckpointAttestationsDecodeError, EscapeHatchStatusUnknownError } from '../errors.js';
import { makeSignedPublishedCheckpoint } from '../test/mock_structs.js';
import {
  type CalldataCheckpointForAttestations,
  getAttestationInfoFromPublishedCheckpoint,
  resolveCheckpointAttestationsFromCalldata,
  validateAttestations,
} from './validation.js';

/**
 * Blob-path wrapper over the shared attestation validator, used only by these tests. Production
 * invalidation always originates from the calldata path (validateCheckpointAttestationsFromCalldata);
 * this repacks a fully decoded checkpoint's attestations to supply the verbatimAttestations field.
 */
function validateCheckpointAttestations(
  publishedCheckpoint: PublishedCheckpoint,
  epochCache: EpochCache,
  constants: Pick<L1RollupConstants, 'epochDuration'>,
  signatureContext: CoordinationSignatureContext,
  logger?: Logger,
): Promise<ValidateCheckpointResult> {
  const { checkpoint, attestations } = publishedCheckpoint;
  const payload = ConsensusPayload.fromCheckpoint(checkpoint, signatureContext);
  const verbatimAttestations = CommitteeAttestationsAndSigners.packAttestations(attestations);
  return validateAttestations(
    payload,
    attestations,
    verbatimAttestations,
    checkpoint.toCheckpointInfo(),
    epochCache,
    constants,
    logger,
  );
}

describe('validateCheckpointAttestations', () => {
  let epochCache: MockProxy<EpochCache>;
  let signers: Secp256k1Signer[];
  let committee: EthAddress[];
  let logger: Logger;

  const constants = { epochDuration: 10 };

  const makeCheckpoint = async (
    signers: Secp256k1Signer[],
    committee: EthAddress[],
    slot?: number,
    feeAssetPriceModifier?: bigint,
  ) => {
    const checkpoint = await Checkpoint.random(CheckpointNumber(1), {
      slotNumber: SlotNumber(slot ?? 1),
      feeAssetPriceModifier,
    });
    return makeSignedPublishedCheckpoint(checkpoint, signers, committee);
  };

  const setCommittee = (committee: EthAddress[], isEscapeHatchOpen = false) => {
    epochCache.getCommitteeForEpoch.mockResolvedValue({
      committee,
      seed: 0n,
      epoch: EpochNumber(0),
      isEscapeHatchOpen,
    });
  };

  beforeEach(() => {
    epochCache = mock<EpochCache>();
    signers = times(5, () => Secp256k1Signer.random());
    committee = signers.map(signer => signer.address);
    logger = createLogger('archiver:test');
  });

  describe('with empty committee', () => {
    beforeEach(() => {
      setCommittee([]);
    });

    it('validates a checkpoint if no committee is found', async () => {
      const checkpoint = await makeCheckpoint([], []);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );

      expect(result.valid).toBe(true);
      expect(epochCache.getCommitteeForEpoch).toHaveBeenCalledWith(EpochNumber(0));
    });

    it('validates a checkpoint with no attestations if no committee is found', async () => {
      const checkpoint = await makeCheckpoint(signers, committee);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );

      expect(result.valid).toBe(true);
      expect(epochCache.getCommitteeForEpoch).toHaveBeenCalledWith(EpochNumber(0));
    });

    it('validates a checkpoint if escape hatch is open', async () => {
      setCommittee([], true);
      const checkpoint = await makeCheckpoint(signers, committee);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('with committee', () => {
    beforeEach(() => {
      setCommittee(committee);
    });

    it('uses feeAssetPriceModifier when recovering attestors', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee, 1, 1n);

      const attestationInfos = getAttestationInfoFromPublishedCheckpoint(
        checkpoint,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
      );
      expect(attestationInfos.filter(a => a.status === 'recovered-from-signature').length).toBe(4);

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      expect(result.valid).toBe(true);
    });

    it('requests committee for the correct epoch', async () => {
      const checkpoint = await makeCheckpoint(signers, committee, 28);
      await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      expect(epochCache.getCommitteeForEpoch).toHaveBeenCalledWith(EpochNumber(2));
    });

    it('fails if there is an attestation from a non-committee member', async () => {
      const badSigner = Secp256k1Signer.random();
      const checkpoint = await makeCheckpoint([...signers, badSigner], [...committee, badSigner.address]);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
      expect(result.invalidIndex).toBe(5); // The bad signer is at index 5
    });

    it('fails if there is an empty attestation', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);
      checkpoint.attestations[1] = new CommitteeAttestation(EthAddress.ZERO, Signature.empty());
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
      expect(result.invalidIndex).toBe(1); // The empty attestation is at index 1
    });

    it('fails if there is an attestation with an invalid signature', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);
      // Create an invalid signature that will fail curve point recovery with "Point is not on curve: Cannot find square root"
      // r = curve_order - 1, s = 1
      const invalidR = Buffer32.fromBuffer(
        Buffer.from('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140', 'hex'),
      );
      const invalidS = Buffer32.fromBuffer(
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000001', 'hex'),
      );
      const invalidSig = new Signature(invalidR, invalidS, 27);
      checkpoint.attestations[0] = new CommitteeAttestation(EthAddress.ZERO, invalidSig);

      // Verify that the invalid signature is detected
      const attestations = getAttestationInfoFromPublishedCheckpoint(checkpoint, TEST_COORDINATION_SIGNATURE_CONTEXT);
      expect(attestations[0].status).toBe('invalid-signature');

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
      expect(result.invalidIndex).toBe(0);
    });

    it('fails if an attestation signature has a high-s value (malleable signature)', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);

      // Flip the signature at index 2 to give it a high-s value
      const original = checkpoint.attestations[2];
      const flipped = flipSignature(original.signature);
      checkpoint.attestations[2] = new CommitteeAttestation(original.address, flipped);

      // Verify the flipped signature is detected as invalid
      const attestations = getAttestationInfoFromPublishedCheckpoint(checkpoint, TEST_COORDINATION_SIGNATURE_CONTEXT);
      expect(attestations[2].status).toBe('invalid-signature');

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
      expect(result.invalidIndex).toBe(2);
    });

    it('fails if an attestation is in yParity (v in {0, 1}) form even though it recovers to the right member', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);

      // Rewrite index 2's canonical signature to its yParity form: same (r, s), recovery byte 0/1. It still
      // recovers to the same committee member off-chain, but L1 ECDSA.recover rejects v not in {27, 28}.
      const original = checkpoint.attestations[2];
      const yParity = new Signature(original.signature.r, original.signature.s, original.signature.v - 27);
      checkpoint.attestations[2] = new CommitteeAttestation(original.address, yParity);

      const attestations = getAttestationInfoFromPublishedCheckpoint(checkpoint, TEST_COORDINATION_SIGNATURE_CONTEXT);
      expect(attestations[2].status).toBe('invalid-signature');

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.invalidIndex).toBe(2);
    });

    it('reports correct index when invalid attestation follows provided address', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 3), committee);

      // Create an attestation with a provided address (index 0)
      checkpoint.attestations[0] = new CommitteeAttestation(signers[0].address, Signature.empty());

      // Create an invalid signature at index 1 - this should be reported as invalid at index 1, not 0
      checkpoint.attestations[1] = new CommitteeAttestation(EthAddress.ZERO, Signature.random());

      // Index 2 is a valid attestation from signers[2]

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.invalidIndex).toBe(1); // Should be 1 (the original index), not 0
    });

    it('returns false if insufficient attestations', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 2), committee);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      expect(result.reason).toBe('insufficient-attestations');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
    });

    it('returns true if all attestations are valid and sufficient', async () => {
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      expect(result.valid).toBe(true);
    });

    it('fails if attestation ordering does not match committee ordering', async () => {
      // Create a checkpoint with attestations in the correct order
      const checkpoint = await makeCheckpoint(signers.slice(0, 4), committee);

      // Swap two attestations to create incorrect ordering
      // This simulates an attacker trying to reorder attestations
      const temp = checkpoint.attestations[1];
      checkpoint.attestations[1] = checkpoint.attestations[2];
      checkpoint.attestations[2] = temp;

      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      assert(!result.valid);
      assert(result.reason === 'invalid-attestation');
      expect(result.checkpoint.checkpointNumber).toEqual(checkpoint.checkpoint.number);
      expect(result.checkpoint.archive.toString()).toEqual(checkpoint.checkpoint.archive.root.toString());
      expect(result.committee).toEqual(committee);
      // The first mismatched attestation should be at index 1
      expect(result.invalidIndex).toBe(1);
    });

    it('validates a checkpoint if escape hatch is open', async () => {
      setCommittee(committee, true);
      const checkpoint = await makeCheckpoint(signers, committee);
      const result = await validateCheckpointAttestations(
        checkpoint,
        epochCache,
        constants,
        TEST_COORDINATION_SIGNATURE_CONTEXT,
        logger,
      );
      expect(result.valid).toBe(true);
    });
  });
});

describe('resolveCheckpointAttestationsFromCalldata', () => {
  let epochCache: MockProxy<EpochCache>;
  let signers: Secp256k1Signer[];
  let committee: EthAddress[];
  let logger: Logger;

  const constants = { epochDuration: 10 };

  beforeEach(() => {
    epochCache = mock<EpochCache>();
    signers = times(5, () => Secp256k1Signer.random());
    committee = signers.map(signer => signer.address);
    logger = createLogger('archiver:test');
    epochCache.getCommitteeForEpoch.mockResolvedValue({
      committee,
      seed: 0n,
      epoch: EpochNumber(0),
      isEscapeHatchOpen: false,
    });
  });

  /**
   * Builds the calldata-only view of a checkpoint the synchronizer resolves attestations for, carrying the
   * given packed tuple. Defaults to the tuple the given signers would have posted.
   */
  const makeCalldataCheckpoint = async (
    attestationSigners: Secp256k1Signer[],
    verbatimAttestations?: ViemCommitteeAttestations,
  ): Promise<CalldataCheckpointForAttestations> => {
    const checkpoint = await Checkpoint.random(CheckpointNumber(1), { slotNumber: SlotNumber(1) });
    const { attestations } = makeSignedPublishedCheckpoint(checkpoint, attestationSigners, committee);
    return {
      checkpointNumber: checkpoint.number,
      archiveRoot: checkpoint.archive.root,
      feeAssetPriceModifier: checkpoint.feeAssetPriceModifier,
      header: checkpoint.header,
      verbatimAttestations: verbatimAttestations ?? CommitteeAttestationsAndSigners.packAttestations(attestations),
    };
  };

  const resolve = (checkpoint: CalldataCheckpointForAttestations) =>
    resolveCheckpointAttestationsFromCalldata(
      checkpoint,
      epochCache,
      constants,
      TEST_COORDINATION_SIGNATURE_CONTEXT,
      logger,
    );

  it('decodes exactly the epoch committee length', async () => {
    const checkpoint = await makeCalldataCheckpoint(signers);

    const { attestations, validationResult } = await resolve(checkpoint);

    expect(attestations).toHaveLength(committee.length);
    expect(validationResult.valid).toBe(true);
    expect(epochCache.getCommitteeForEpoch).toHaveBeenCalledWith(EpochNumber(0));
  });

  it('surfaces an invalid result from the decoded array', async () => {
    // None of the signers is in the committee, so their signatures land in no committee slot and the
    // checkpoint ends up with nothing counting towards quorum.
    const checkpoint = await makeCalldataCheckpoint(times(5, () => Secp256k1Signer.random()));

    const { attestations, validationResult } = await resolve(checkpoint);

    expect(attestations).toHaveLength(committee.length);
    assert(!validationResult.valid);
    expect(validationResult.reason).toEqual('insufficient-attestations');
  });

  it('returns no attestations without decoding when the escape hatch is open', async () => {
    // The tuple an escape-hatch proposer posts is arbitrary: this one promises a signature it does not
    // carry, so any committee-sized decode of it throws.
    epochCache.getCommitteeForEpoch.mockResolvedValue({
      committee,
      seed: 0n,
      epoch: EpochNumber(0),
      isEscapeHatchOpen: true,
    });
    const checkpoint = await makeCalldataCheckpoint(signers, {
      signatureIndices: '0x80',
      signaturesOrAddresses: '0xab',
    });

    const { attestations, validationResult } = await resolve(checkpoint);

    expect(attestations).toEqual([]);
    expect(validationResult.valid).toBe(true);
  });

  it('returns no attestations when the epoch has no committee', async () => {
    epochCache.getCommitteeForEpoch.mockResolvedValue({
      committee: [],
      seed: 0n,
      epoch: EpochNumber(0),
      isEscapeHatchOpen: false,
    });
    const checkpoint = await makeCalldataCheckpoint(signers);

    const { attestations, validationResult } = await resolve(checkpoint);

    expect(attestations).toEqual([]);
    expect(validationResult.valid).toBe(true);
  });

  it('refuses to judge a checkpoint while the escape hatch status is unknown', async () => {
    // A decodable tuple with no committee signatures: were the hatch treated as closed, this checkpoint
    // would be rejected for good, though a hatch proposer may legitimately have posted it.
    epochCache.getCommitteeForEpoch.mockResolvedValue({
      committee,
      seed: 0n,
      epoch: EpochNumber(0),
      isEscapeHatchOpen: false,
      isEscapeHatchStatusUnknown: true,
    });
    const checkpoint = await makeCalldataCheckpoint(times(5, () => Secp256k1Signer.random()));

    await expect(resolve(checkpoint)).rejects.toThrow(EscapeHatchStatusUnknownError);
  });

  it('throws a decode error for a non-hatch checkpoint whose tuple is too short', async () => {
    const checkpoint = await makeCalldataCheckpoint(signers, {
      signatureIndices: '0x80',
      signaturesOrAddresses: '0xab',
    });

    await expect(resolve(checkpoint)).rejects.toThrow(CheckpointAttestationsDecodeError);
  });
});
