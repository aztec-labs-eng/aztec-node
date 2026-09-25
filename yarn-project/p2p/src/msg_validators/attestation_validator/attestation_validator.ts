import type { EpochCacheInterface } from '@aztec-labs/epoch-cache';
import { NoCommitteeError } from '@aztec-labs/ethereum/contracts';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import {
  type CheckpointAttestation,
  type CoordinationSignatureContext,
  type P2PValidator,
  PeerErrorSeverity,
  type ValidationResult,
  hasValidSignatureContext,
} from '@aztec-labs/stdlib/p2p';
import type { ConsensusTimetable } from '@aztec-labs/stdlib/timetable';

import { classifyReceiveWindowArrival } from '../receive_window.js';

export class CheckpointAttestationValidator implements P2PValidator<CheckpointAttestation> {
  protected epochCache: EpochCacheInterface;
  protected logger: Logger;
  private readonly timetable: ConsensusTimetable;
  protected readonly signatureContext: CoordinationSignatureContext;
  private readonly clockDisparityMs: number;

  constructor(
    epochCache: EpochCacheInterface,
    timetable: ConsensusTimetable,
    opts: {
      signatureContext: CoordinationSignatureContext;
      clockDisparityMs: number;
    },
  ) {
    this.epochCache = epochCache;
    this.timetable = timetable;
    this.signatureContext = opts.signatureContext;
    this.clockDisparityMs = opts.clockDisparityMs;
    this.logger = createLogger('p2p:checkpoint-attestation-validator');
  }

  async validate(message: CheckpointAttestation): Promise<ValidationResult> {
    const slotNumber = message.payload.header.slotNumber;

    // Only the epochCache committee/proposer lookups can fail on receiver-local causes (L1 RPC down,
    // or this node behind), and that says nothing about the relaying peer. Map such a failure to
    // ignore rather than letting it throw, since a thrown validation defaults to reject + penalize
    // and would punish an honest relayer for our own failure. A missing committee is still the peer's
    // fault (they shouldn't be sending it), so it stays a reject. This is scoped to just the lookups:
    // any other error in validation still throws and surfaces.
    const onLookupFailure = (e: unknown): ValidationResult => {
      if (e instanceof NoCommitteeError) {
        this.logger.warn(`No committee exists for checkpoint attestation for slot ${slotNumber}`);
        return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
      }
      this.logger.warn(
        `Ignoring checkpoint attestation for slot ${slotNumber} after a local committee lookup failure`,
        {
          error: e instanceof Error ? e.message : String(e),
        },
      );
      return { result: 'ignore' };
    };

    // Cross-chain replay check: reject attestations that carry a foreign signing domain.
    if (!hasValidSignatureContext(message.payload, this.signatureContext)) {
      this.logger.warn(`Rejecting checkpoint attestation with foreign signature context for slot ${slotNumber}`, {
        chainId: message.payload.signatureContext.chainId,
        rollupAddress: message.payload.signatureContext.rollupAddress.toString(),
        expectedChainId: this.signatureContext.chainId,
        expectedRollupAddress: this.signatureContext.rollupAddress.toString(),
      });
      return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
    }

    // Accept attestations whose explicit per-slot receive window contains the current wall-clock time.
    // The window spans the build-frame start (attestation_receive_start) to the attestation deadline
    // (target_slot_start + S - 2E), widened by the configured clock-disparity tolerance on both ends, so
    // it covers the build slot, the target slot, and clock-disparity grace. This is the sole arrival
    // gate; attestations are otherwise attributed by content, not by current/next slot.
    const startSeconds = this.timetable.getAttestationReceiveStart(slotNumber);
    const deadlineSeconds = this.timetable.getAttestationDeadline(slotNumber);
    const nowMs = Number(this.epochCache.getEpochAndSlotNow().nowMs);
    const windowMiss = classifyReceiveWindowArrival(
      nowMs,
      startSeconds * 1000 - this.clockDisparityMs,
      deadlineSeconds * 1000 + this.clockDisparityMs,
    );
    if (windowMiss) {
      this.logger.warn(
        `Checkpoint attestation slot ${slotNumber} is outside its receive window (${windowMiss.outcome.result})`,
        {
          slotNumber,
          nowMs,
          missMs: windowMiss.missMs,
          windowStartSeconds: startSeconds,
          windowDeadlineSeconds: deadlineSeconds,
        },
      );
      return windowMiss.outcome;
    }

    // Verify the signature is valid
    const attester = message.getSender();
    if (attester === undefined) {
      this.logger.warn(`Invalid signature in checkpoint attestation for slot ${slotNumber}`);
      return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
    }

    // Verify the attester is in the committee for this slot
    let inCommittee: boolean;
    try {
      inCommittee = await this.epochCache.isInCommittee(slotNumber, attester);
    } catch (e) {
      return onLookupFailure(e);
    }
    if (!inCommittee) {
      this.logger.warn(`Attester ${attester.toString()} is not in committee for slot ${slotNumber}`);
      return { result: 'reject', severity: PeerErrorSeverity.HighToleranceError };
    }

    // Verify the proposer signature matches the expected proposer for the attestation's slot
    // We look up the proposer for the specific slot rather than using currentSlot/nextSlot
    // since timing differences could cause mismatches
    const proposer = message.getProposer();
    let expectedProposer;
    try {
      expectedProposer = await this.epochCache.getProposerAttesterAddressInSlot(slotNumber);
    } catch (e) {
      return onLookupFailure(e);
    }
    if (!expectedProposer) {
      this.logger.warn(`No proposer defined for slot ${slotNumber}`);
      return { result: 'reject', severity: PeerErrorSeverity.HighToleranceError };
    }
    if (!proposer) {
      this.logger.warn(`Invalid proposer signature in checkpoint attestation for slot ${slotNumber}`);
      return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
    }
    if (!proposer.equals(expectedProposer)) {
      this.logger.warn(
        `Proposer signature mismatch in checkpoint attestation. ` +
          `Expected ${expectedProposer?.toString() ?? 'none'} but got ${proposer.toString()} for slot ${slotNumber}`,
      );
      return { result: 'reject', severity: PeerErrorSeverity.HighToleranceError };
    }

    return { result: 'accept' };
  }
}
