import { NoCommitteeError } from '@aztec-labs/ethereum/contracts';
import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Logger } from '@aztec-labs/foundation/log';
import { PeerErrorSeverity, type ValidationResult } from '@aztec-labs/stdlib/p2p';

/**
 * Maps a failure of an epoch-cache lookup during p2p validation to a verdict, shared by the proposal
 * and attestation validators so the "a local epoch-cache failure is never the relaying peer's fault"
 * rule lives in one place.
 *
 * A missing committee (`NoCommitteeError`) is the peer's fault — they should not be sending us a
 * proposal/attestation for a slot with no committee — so it rejects. Any other failure is
 * receiver-local (an L1 RPC outage, or this node being behind) and says nothing about the relaying
 * peer, so it ignores rather than penalizes. Only the local failure is warned; a missing committee is
 * a routine peer-fault reject and needs no log line.
 *
 * `subject` names the gossip object for the log ("proposal" / "checkpoint attestation").
 */
export function mapEpochCacheLookupFailure(
  e: unknown,
  logger: Logger,
  subject: string,
  slotNumber: SlotNumber,
): ValidationResult {
  if (e instanceof NoCommitteeError) {
    return { result: 'reject', severity: PeerErrorSeverity.LowToleranceError };
  }
  logger.warn(`Ignoring ${subject} for slot ${slotNumber} after a local epoch-cache lookup failure`, {
    slotNumber,
    error: e instanceof Error ? e.message : String(e),
  });
  return { result: 'ignore' };
}
