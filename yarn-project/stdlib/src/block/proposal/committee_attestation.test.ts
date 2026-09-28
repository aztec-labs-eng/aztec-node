import type { ViemCommitteeAttestations } from '@aztec-labs/ethereum/contracts';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { bufferToHex } from '@aztec-labs/foundation/string';

import { CommitteeAttestationsAndSigners } from './attestations_and_signers.js';
import { CommitteeAttestation } from './committee_attestation.js';

/**
 * Reference decoder, kept byte-for-byte as `fromPacked` was written before it stopped round-tripping `r` and
 * `s` through hex strings. The production decoder must stay indistinguishable from it.
 */
function referenceFromPacked(packed: ViemCommitteeAttestations, committeeSize: number): CommitteeAttestation[] {
  const signatureIndicesBuffer = Buffer.from(packed.signatureIndices.slice(2), 'hex');
  const dataBuffer = Buffer.from(packed.signaturesOrAddresses.slice(2), 'hex');

  const attestations: CommitteeAttestation[] = [];
  let dataIndex = 0;

  for (let i = 0; i < committeeSize; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = 7 - (i % 8);
    const hasSignature =
      byteIndex < signatureIndicesBuffer.length && (signatureIndicesBuffer[byteIndex] & (1 << bitIndex)) !== 0;

    if (hasSignature) {
      if (dataIndex + 65 > dataBuffer.length) {
        throw new Error(`Insufficient data for signature at position ${i}`);
      }
      const v = dataBuffer[dataIndex];
      const r = `0x${dataBuffer.subarray(dataIndex + 1, dataIndex + 33).toString('hex')}` as const;
      const s = `0x${dataBuffer.subarray(dataIndex + 33, dataIndex + 65).toString('hex')}` as const;
      attestations.push(new CommitteeAttestation(EthAddress.ZERO, Signature.fromViemSignature({ r, s, v })));
      dataIndex += 65;
    } else {
      if (dataIndex + 20 > dataBuffer.length) {
        throw new Error(`Insufficient data for address at position ${i}`);
      }
      const addressBytes = dataBuffer.subarray(dataIndex, dataIndex + 20);
      attestations.push(
        new CommitteeAttestation(EthAddress.fromString(`0x${addressBytes.toString('hex')}`), Signature.empty()),
      );
      dataIndex += 20;
    }
  }

  return attestations;
}

/** A committee where every third member signed, so both branches of the decoder are exercised. */
function mixedCommittee(size: number): CommitteeAttestation[] {
  return Array.from({ length: size }, (_, i) =>
    i % 3 === 0 ? CommitteeAttestation.fromSignature(Signature.random()) : CommitteeAttestation.random(),
  );
}

describe('CommitteeAttestation.fromPacked', () => {
  it('decodes a signing/non-signing mix identically to the reference decoder', () => {
    const committee = mixedCommittee(11);
    const packed = CommitteeAttestationsAndSigners.packAttestations(committee);

    const decoded = CommitteeAttestation.fromPacked(packed, committee.length);

    expect(decoded).toEqual(referenceFromPacked(packed, committee.length));
    expect(decoded.map(a => a.toBuffer())).toEqual(
      referenceFromPacked(packed, committee.length).map(a => a.toBuffer()),
    );
  });

  it('round-trips signatures and addresses', () => {
    const signature = Signature.random();
    const address = EthAddress.random();
    const packed = CommitteeAttestationsAndSigners.packAttestations([
      CommitteeAttestation.fromSignature(signature),
      CommitteeAttestation.fromAddress(address),
    ]);

    const decoded = CommitteeAttestation.fromPacked(packed, 2);

    // Signing slots carry no address: the signer is recovered from the signature.
    expect(decoded[0]).toEqual(new CommitteeAttestation(EthAddress.ZERO, signature));
    expect(decoded[1]).toEqual(new CommitteeAttestation(address, Signature.empty()));
  });

  it('copies out of the packed payload so decoded values do not alias each other', () => {
    const committee = mixedCommittee(4);
    const packed = CommitteeAttestationsAndSigners.packAttestations(committee);

    const decoded = CommitteeAttestation.fromPacked(packed, committee.length);
    const expected = decoded.map(a => a.toBuffer());
    decoded[0].signature.r.buffer.fill(0xff);

    expect(decoded.slice(1).map(a => a.toBuffer())).toEqual(expected.slice(1));
  });

  it('reads only the bits within the committee size', () => {
    const addresses = [EthAddress.random(), EthAddress.random(), EthAddress.random()];
    const honest = CommitteeAttestationsAndSigners.packAttestations(addresses.map(CommitteeAttestation.fromAddress));
    // A committee of three occupies bits 7..5 of the single bitmap byte; bit 0 maps to no committee position.
    const withSpareBit: ViemCommitteeAttestations = { ...honest, signatureIndices: '0x01' };

    expect(CommitteeAttestation.fromPacked(withSpareBit, 3)).toEqual(CommitteeAttestation.fromPacked(honest, 3));
  });

  it('throws when the payload is too short for the bitmap it carries', () => {
    const truncated: ViemCommitteeAttestations = {
      signatureIndices: '0x80',
      signaturesOrAddresses: bufferToHex(Buffer32.random().toBuffer()),
    };

    expect(() => CommitteeAttestation.fromPacked(truncated, 1)).toThrow('Insufficient data for signature');
  });
});
