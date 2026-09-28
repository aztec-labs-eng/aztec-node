import type { ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';

import { CommitteeAttestationsAndSigners } from '../block/proposal/attestations_and_signers.js';
import { CommitteeAttestation } from '../block/proposal/committee_attestation.js';
import { Checkpoint } from './checkpoint.js';
import { L1PublishedData, PublishedCheckpoint } from './published_checkpoint.js';

describe('PublishedCheckpoint serialization', () => {
  const makeAttestations = () => [
    CommitteeAttestation.fromSignature(Signature.random()),
    CommitteeAttestation.fromAddress(EthAddress.random()),
    CommitteeAttestation.fromSignature(Signature.random()),
  ];

  it('round-trips the packed attestations tuple', async () => {
    const attestations = makeAttestations();
    const published = new PublishedCheckpoint(
      await Checkpoint.random(CheckpointNumber(1)),
      L1PublishedData.random(),
      attestations,
      CommitteeAttestationsAndSigners.packAttestations(attestations),
    );

    const roundTripped = PublishedCheckpoint.fromBuffer(published.toBuffer());

    expect(roundTripped.verbatimAttestations).toEqual(published.verbatimAttestations);
    expect(roundTripped.attestations).toEqual(published.attestations);
    expect(roundTripped.toBuffer()).toEqual(published.toBuffer());
  });

  it('preserves bitmap bits past the committee size', async () => {
    const attestations = [CommitteeAttestation.fromAddress(EthAddress.random())];
    const honest = CommitteeAttestationsAndSigners.packAttestations(attestations);
    // A committee of one occupies bit 7 of the single bitmap byte; bits 6..0 map to no committee position.
    const verbatimAttestations: ViemCommitteeAttestations = { ...honest, signatureIndices: '0x01' };
    const published = new PublishedCheckpoint(
      await Checkpoint.random(CheckpointNumber(1)),
      L1PublishedData.random(),
      attestations,
      verbatimAttestations,
    );

    const roundTripped = PublishedCheckpoint.fromBuffer(published.toBuffer());

    expect(roundTripped.verbatimAttestations.signatureIndices).toEqual('0x01');
  });

  it('round-trips an empty attestations tuple', async () => {
    const published = new PublishedCheckpoint(
      await Checkpoint.random(CheckpointNumber(1)),
      L1PublishedData.random(),
      [],
      CommitteeAttestationsAndSigners.packAttestations([]),
    );

    const roundTripped = PublishedCheckpoint.fromBuffer(published.toBuffer());

    expect(roundTripped.verbatimAttestations).toEqual({ signatureIndices: '0x', signaturesOrAddresses: '0x' });
  });
});
