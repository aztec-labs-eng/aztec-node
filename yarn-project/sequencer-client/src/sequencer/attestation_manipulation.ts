import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { randomInt } from '@aztec-labs/foundation/crypto/random';
import {
  flipSignature,
  generateRecoverableSignature,
  generateUnrecoverableSignature,
} from '@aztec-labs/foundation/crypto/secp256k1-signer';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import { unfreeze } from '@aztec-labs/foundation/types';
import {
  type CommitteeAttestation,
  CommitteeAttestationsAndSigners,
  MaliciousCommitteeAttestationsAndSigners,
  MaliciousYParityCommitteeAttestationsAndSigners,
} from '@aztec-labs/stdlib/block';
import type { SequencerConfig } from '@aztec-labs/stdlib/interfaces/server';
import type { CoordinationSignatureContext } from '@aztec-labs/stdlib/p2p';

/** The test-only sequencer flags that make the proposer publish deliberately broken attestations. */
export type AttestationManipulationConfig = Pick<
  SequencerConfig,
  | 'injectFakeAttestation'
  | 'injectHighSValueAttestation'
  | 'injectUnrecoverableSignatureAttestation'
  | 'injectYParityAttestation'
  | 'shuffleAttestationOrdering'
>;

/** Whether any test-only attestation attack is configured. */
export function hasAttestationManipulation(config: AttestationManipulationConfig): boolean {
  return !!(
    config.injectFakeAttestation ||
    config.injectHighSValueAttestation ||
    config.injectUnrecoverableSignatureAttestation ||
    config.injectYParityAttestation ||
    config.shuffleAttestationOrdering
  );
}

/** Breaks the attestations before publishing based on attack configs. */
export function manipulateAttestations(input: {
  config: AttestationManipulationConfig;
  epochCache: Pick<EpochCache, 'computeProposerIndex'>;
  signatureContext: CoordinationSignatureContext;
  log: Logger;
  slotNumber: SlotNumber;
  epoch: EpochNumber;
  seed: bigint;
  committee: EthAddress[];
  attestations: CommitteeAttestation[];
}): CommitteeAttestationsAndSigners {
  const { config, epochCache, signatureContext, log, slotNumber, epoch, seed, committee, attestations } = input;

  // Compute the proposer index in the committee, since we dont want to tweak it.
  // Otherwise, the L1 rollup contract will reject the block outright.
  const proposerIndex = Number(epochCache.computeProposerIndex(slotNumber, epoch, seed, BigInt(committee.length)));

  if (
    config.injectFakeAttestation ||
    config.injectHighSValueAttestation ||
    config.injectUnrecoverableSignatureAttestation
  ) {
    // Find non-empty attestations that are not from the proposer
    const nonProposerIndices: number[] = [];
    for (let i = 0; i < attestations.length; i++) {
      if (!attestations[i].signature.isEmpty() && i !== proposerIndex) {
        nonProposerIndices.push(i);
      }
    }
    if (nonProposerIndices.length > 0) {
      const targetIndex = nonProposerIndices[randomInt(nonProposerIndices.length)];
      if (config.injectHighSValueAttestation) {
        log.warn(`Injecting high-s value attestation in checkpoint for slot ${slotNumber} at index ${targetIndex}`);
        unfreeze(attestations[targetIndex]).signature = flipSignature(attestations[targetIndex].signature);
      } else if (config.injectUnrecoverableSignatureAttestation) {
        log.warn(
          `Injecting unrecoverable signature attestation in checkpoint for slot ${slotNumber} at index ${targetIndex}`,
        );
        unfreeze(attestations[targetIndex]).signature = generateUnrecoverableSignature();
      } else {
        log.warn(`Injecting fake attestation in checkpoint for slot ${slotNumber} at index ${targetIndex}`);
        unfreeze(attestations[targetIndex]).signature = generateRecoverableSignature();
      }
    }
    return new CommitteeAttestationsAndSigners(attestations, signatureContext);
  }

  if (config.injectYParityAttestation) {
    // Force every non-proposer signed slot's recovery byte to yParity (v ∈ {0, 1}) form in the packed L1
    // tuple, after packAttestations has canonicalized it. The proposer's own slot is left canonical so
    // propose() still passes verifyProposer. Models a malicious proposer landing a checkpoint L1 accepts
    // but that can never be proven (ECDSA.recover rejects v ∉ {27, 28}).
    log.warn(`Injecting yParity attestations in checkpoint for slot ${slotNumber} (proposer #${proposerIndex})`);
    return new MaliciousYParityCommitteeAttestationsAndSigners(attestations, proposerIndex, signatureContext);
  }

  if (config.shuffleAttestationOrdering) {
    log.warn(`Shuffling attestation ordering in checkpoint for slot ${slotNumber} (proposer #${proposerIndex})`);

    const shuffled = [...attestations];

    // Find two non-proposer positions that both have non-empty signatures to swap.
    // This ensures the bitmap doesn't change, so the MaliciousCommitteeAttestationsAndSigners
    // signers array stays correctly aligned with L1's committee reconstruction.
    const swappable: number[] = [];
    for (let k = 0; k < shuffled.length; k++) {
      if (!shuffled[k].signature.isEmpty() && k !== proposerIndex) {
        swappable.push(k);
      }
    }
    if (swappable.length >= 2) {
      const [i, j] = [swappable[0], swappable[1]];
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const signers = new CommitteeAttestationsAndSigners(attestations, signatureContext).getSigners();
    return new MaliciousCommitteeAttestationsAndSigners(shuffled, signers, signatureContext);
  }

  return new CommitteeAttestationsAndSigners(attestations, signatureContext);
}
