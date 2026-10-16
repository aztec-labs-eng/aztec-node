import type { UnstableCommittee } from '@aztec-labs/epoch-cache';
import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Logger } from '@aztec-labs/foundation/log';
import { PeerErrorSeverity, type ValidationResult } from '@aztec-labs/stdlib/p2p';

// Verdicts shared by the proposal and attestation validators, so the "a local epoch-cache failure is never the
// relaying peer's fault" rule lives in one place.

/**
 * A slot with no committee on L1 is the peer's fault — they should not be sending us a proposal or attestation for it
 * — so it rejects. It is a routine peer-fault reject and needs no log line.
 */
export function rejectNoCommittee(): ValidationResult {
  return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
}

/**
 * A committee whose seed is not fixed on L1 yet says nothing about the relaying peer, and is expected around epoch
 * boundaries, so it ignores without a warning.
 */
export function ignoreUnstableCommittee(
  lookup: UnstableCommittee,
  logger: Logger,
  subject: string,
  slotNumber: SlotNumber,
): ValidationResult {
  logger.debug(`Ignoring ${subject} for slot ${slotNumber}: its committee is not stable on L1 yet`, {
    slotNumber,
    epoch: lookup.epoch,
    l1BlockNumber: lookup.l1BlockNumber,
  });
  return { result: 'ignore' };
}

/**
 * A lookup that throws failed for a receiver-local reason (an L1 RPC outage, or this node being behind), so it ignores
 * rather than penalizes, and warns. `subject` names the gossip object for the log ("proposal" / "checkpoint
 * attestation").
 */
export function mapEpochCacheLookupFailure(
  e: unknown,
  logger: Logger,
  subject: string,
  slotNumber: SlotNumber,
): ValidationResult {
  logger.warn(`Ignoring ${subject} for slot ${slotNumber} after a local epoch-cache lookup failure`, {
    slotNumber,
    error: e instanceof Error ? e.message : String(e),
  });
  return { result: 'ignore' };
}
