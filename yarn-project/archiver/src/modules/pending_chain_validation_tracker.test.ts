import { EpochNumber } from '@aztec-labs/foundation/branded-types';
import {
  CommitteeAttestationsAndSigners,
  type ValidateCheckpointNegativeResult,
  type ValidateCheckpointResult,
} from '@aztec-labs/stdlib/block';
import { randomCheckpointInfo } from '@aztec-labs/stdlib/checkpoint';

import { PendingChainValidationTracker } from './pending_chain_validation_tracker.js';

describe('PendingChainValidationTracker', () => {
  const valid = (): ValidateCheckpointResult => ({ valid: true });

  const invalid = (checkpointNumber: number): ValidateCheckpointNegativeResult => ({
    valid: false,
    reason: 'insufficient-attestations',
    checkpoint: randomCheckpointInfo(checkpointNumber),
    committee: [],
    epoch: EpochNumber(1),
    seed: 0n,
    attestors: [],
    attestations: [],
    verbatimAttestations: CommitteeAttestationsAndSigners.packAttestations([]),
  });

  const noAncestor = { hasRejectedAncestor: false };

  it('adopts a valid result when there is no initial status', () => {
    const tracker = new PendingChainValidationTracker(undefined);
    const observed = valid();
    tracker.observe(observed, noAncestor);
    expect(tracker.update).toBe(observed);
  });

  it('moves from valid to the first invalid checkpoint', () => {
    const tracker = new PendingChainValidationTracker(valid());
    const observed = invalid(2);
    tracker.observe(observed, noAncestor);
    expect(tracker.update).toBe(observed);
  });

  it('keeps the first invalid checkpoint when a later one with a different number is invalid', () => {
    const tracker = new PendingChainValidationTracker(invalid(2));
    tracker.observe(invalid(3), noAncestor);
    expect(tracker.update).toBeUndefined();
  });

  it('replaces an invalid checkpoint with another invalid one of the same number', () => {
    const initial = invalid(2);
    const tracker = new PendingChainValidationTracker(initial);
    const replacement = invalid(2);
    tracker.observe(replacement, noAncestor);
    expect(tracker.update).toBe(replacement);
    expect(tracker.update).not.toBe(initial);
  });

  it('ignores observations of checkpoints with a rejected ancestor', () => {
    const tracker = new PendingChainValidationTracker(invalid(2));
    tracker.observe(valid(), { hasRejectedAncestor: true });
    tracker.observe(invalid(2), { hasRejectedAncestor: true });
    expect(tracker.update).toBeUndefined();
  });

  it('moves from invalid back to valid', () => {
    const tracker = new PendingChainValidationTracker(invalid(2));
    const observed = valid();
    tracker.observe(observed, noAncestor);
    expect(tracker.update).toBe(observed);
  });

  it('reports no update when a distinct valid result follows a valid initial status', () => {
    const tracker = new PendingChainValidationTracker(valid());
    tracker.observe(valid(), noAncestor);
    expect(tracker.update).toBeUndefined();
  });

  it('keeps reporting a moved status after a descendant is observed', () => {
    const tracker = new PendingChainValidationTracker(valid());
    const observed = invalid(2);
    tracker.observe(observed, noAncestor);
    expect(tracker.update).toBe(observed);
    tracker.observe(valid(), { hasRejectedAncestor: true });
    expect(tracker.update).toBe(observed);
  });
});
