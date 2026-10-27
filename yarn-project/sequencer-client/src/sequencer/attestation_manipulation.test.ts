import type { EpochCache } from '@aztec-labs/epoch-cache';
import { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { flipSignature } from '@aztec-labs/foundation/crypto/secp256k1-signer';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { Signature } from '@aztec-labs/foundation/eth-signature';
import { createLogger } from '@aztec-labs/foundation/log';
import {
  CommitteeAttestation,
  CommitteeAttestationsAndSigners,
  MaliciousCommitteeAttestationsAndSigners,
  MaliciousYParityCommitteeAttestationsAndSigners,
} from '@aztec-labs/stdlib/block';
import type { CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';
import { type MockProxy, mock } from 'jest-mock-extended';

import {
  type AttestationManipulationConfig,
  hasAttestationManipulation,
  manipulateAttestations,
} from './attestation_manipulation.js';

describe('attestation manipulation', () => {
  const signatureContext: CoordinationSignatureContext = { chainId: 1, rollupAddress: EthAddress.random() };
  const proposerIndex = 1;

  let epochCache: MockProxy<Pick<EpochCache, 'computeProposerIndex'>>;
  let committee: EthAddress[];
  let attestations: CommitteeAttestation[];
  let originalSignatures: Signature[];

  const run = (config: AttestationManipulationConfig) =>
    manipulateAttestations({
      config,
      epochCache,
      signatureContext,
      log: createLogger('sequencer:test'),
      slotNumber: SlotNumber(10),
      epoch: EpochNumber(1),
      seed: 42n,
      committee,
      attestations,
    });

  beforeEach(() => {
    epochCache = mock<Pick<EpochCache, 'computeProposerIndex'>>();
    epochCache.computeProposerIndex.mockReturnValue(BigInt(proposerIndex));
    committee = Array.from({ length: 4 }, () => EthAddress.random());
    // The last member has not signed, so it is never a manipulation target.
    attestations = committee.map((address, i) =>
      i === 3 ? CommitteeAttestation.fromAddress(address) : new CommitteeAttestation(address, Signature.random()),
    );
    originalSignatures = attestations.map(a => a.signature);
  });

  const changedIndices = () =>
    attestations.map((a, i) => (a.signature.equals(originalSignatures[i]) ? -1 : i)).filter(i => i >= 0);

  it('detects whether any attack flag is set', () => {
    expect(hasAttestationManipulation({})).toBe(false);
    expect(hasAttestationManipulation({ injectFakeAttestation: false })).toBe(false);
    for (const flag of [
      'injectFakeAttestation',
      'injectHighSValueAttestation',
      'injectUnrecoverableSignatureAttestation',
      'injectYParityAttestation',
      'shuffleAttestationOrdering',
    ] as const) {
      expect(hasAttestationManipulation({ [flag]: true })).toBe(true);
    }
  });

  it('replaces one non-proposer signature with a fake one', () => {
    const result = run({ injectFakeAttestation: true });

    expect(result).not.toBeInstanceOf(MaliciousCommitteeAttestationsAndSigners);
    expect(result).not.toBeInstanceOf(MaliciousYParityCommitteeAttestationsAndSigners);
    const changed = changedIndices();
    expect(changed).toHaveLength(1);
    expect([0, 2]).toContain(changed[0]);
  });

  it('flips one non-proposer signature to its high-s form', () => {
    run({ injectHighSValueAttestation: true });

    const changed = changedIndices();
    expect(changed).toHaveLength(1);
    expect(changed[0]).not.toBe(proposerIndex);
    expect(attestations[changed[0]].signature).toEqual(flipSignature(originalSignatures[changed[0]]));
  });

  it('wraps the attestations for a yParity attack', () => {
    const result = run({ injectYParityAttestation: true });

    expect(result).toBeInstanceOf(MaliciousYParityCommitteeAttestationsAndSigners);
    expect(changedIndices()).toEqual([]);
  });

  it('swaps two signed non-proposer attestations while keeping the signers', () => {
    const signers = new CommitteeAttestationsAndSigners(attestations, signatureContext).getSigners();

    const result = run({ shuffleAttestationOrdering: true });

    expect(result).toBeInstanceOf(MaliciousCommitteeAttestationsAndSigners);
    expect(result.attestations.map(a => a.address)).toEqual([committee[2], committee[1], committee[0], committee[3]]);
    expect(result.getSigners()).toEqual(signers);
  });
});
