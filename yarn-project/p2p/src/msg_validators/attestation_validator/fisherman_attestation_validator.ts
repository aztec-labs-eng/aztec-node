import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import type { CheckpointAttestation, CoordinationSignatureContext, ValidationResult } from '@aztec-labs/stdlib/p2p';
import type { ConsensusTimetable } from '@aztec-labs/stdlib/timetable';
import {
  Attributes,
  Metrics,
  type TelemetryClient,
  createUpDownCounterWithDefault,
} from '@aztec-labs/telemetry-client';

import type { AttestationPoolApi } from '../../mem_pools/attestation_pool/attestation_pool.js';
import { CheckpointAttestationValidator } from './attestation_validator.js';

/**
 * FishermanAttestationValidator extends the base AttestationValidator to add
 * additional validation for fisherman nodes: verifying that attestations sign
 * the same payload as the original proposal.
 * Invalid attestations are rejected (not propagated), but peer penalization is
 * handled by LibP2PService based on the fishermanMode config to ensure a better
 * view of the network.
 */
export class FishermanAttestationValidator extends CheckpointAttestationValidator {
  private invalidAttestationCounter;

  constructor(
    epochCache: EpochCacheInterface,
    timetable: ConsensusTimetable,
    private attestationPool: AttestationPoolApi,
    telemetryClient: TelemetryClient,
    opts: {
      signatureContext: CoordinationSignatureContext;
      clockDisparityMs: number;
    },
  ) {
    super(epochCache, timetable, opts);
    this.logger = this.logger.createChild('[FISHERMAN]');

    const meter = telemetryClient.getMeter('FishermanAttestationValidator');
    this.invalidAttestationCounter = createUpDownCounterWithDefault(
      meter,
      Metrics.VALIDATOR_INVALID_ATTESTATION_RECEIVED_COUNT,
      {
        [Attributes.ERROR_TYPE]: ['base_validation_failed', 'payload_mismatch'],
      },
    );
  }

  override async validate(message: CheckpointAttestation): Promise<ValidationResult> {
    // First run the standard validation
    const baseValidationResult = await super.validate(message);
    if (baseValidationResult.result !== 'accept') {
      // Track base validation failures (invalid signature, wrong committee, etc.)
      this.invalidAttestationCounter.add(1, {
        [Attributes.ERROR_TYPE]: 'base_validation_failed',
      });
      return baseValidationResult;
    }

    // fisherman validation: verify attestation payload matches proposal payload
    const slotNumberBigInt = message.payload.header.slotNumber;
    const attester = message.getSender();
    const proposer = message.getProposer();

    if (!attester || !proposer) {
      return { result: 'accept' };
    }

    const proposal = await this.attestationPool.getCheckpointProposal(message.payload.header.slotNumber);

    if (proposal) {
      // Compare the attestation payload with the proposal payload
      if (!message.payload.equals(proposal)) {
        this.logger.error(
          `Attestation payload mismatch for slot ${slotNumberBigInt}! ` +
            `Attester ${attester.toString()} signed different data than the proposal.`,
          {
            slot: slotNumberBigInt.toString(),
            attester: attester.toString(),
            proposer: proposer.toString(),
            proposalArchive: proposal.archive.toString(),
            attestationArchive: message.archive.toString(),
            proposalHeader: proposal.checkpointHeader.hash().toString(),
            attestationHeader: message.payload.header.hash().toString(),
          },
        );

        // Track invalid attestation metric
        this.invalidAttestationCounter.add(1, {
          [Attributes.ERROR_TYPE]: 'payload_mismatch',
        });

        // Ignore, do not reject: a reject penalizes the relaying peer (the reject path has no
        // fisherman-mode exemption), and the mismatch is not the relayer's fault. When the proposer
        // equivocated, an honest attester may have signed the other valid proposal for this slot, and
        // the relayer cannot know which of the equivocated proposals we retained. The mismatch is
        // still counted above for fisherman evidence; slashing the attester is a separate on-chain
        // path, not a gossip-relayer penalty.
        return { result: 'ignore' };
      }
    } else {
      // We might receive attestations before proposals in some cases
      this.logger.debug(`Received attestation for slot ${slotNumberBigInt} but proposal not found yet.`);
    }

    return { result: 'accept' };
  }
}
