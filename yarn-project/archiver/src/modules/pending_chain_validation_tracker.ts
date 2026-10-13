import type { ValidateCheckpointResult } from '@aztec-labs/stdlib/block';

/**
 * Tracks the pending chain's validation status while one sync iteration screens checkpoints, so that the status
 * persisted points at the first invalid checkpoint of a run. A later invalid checkpoint replaces it only when it
 * carries the same number (an invalidated checkpoint replaced by another invalid one, which must itself become
 * invalidatable); a descendant of a rejected checkpoint never replaces it, keeping the original invalidation target.
 * `update` compares against the object the iteration started from, so once the status has moved it is reported on
 * every batch of that iteration, and never while it is still the initial object.
 */
export class PendingChainValidationTracker {
  private current: ValidateCheckpointResult | undefined;

  constructor(private readonly initial: ValidateCheckpointResult | undefined) {
    this.current = initial;
  }

  /** Records the screening result of one checkpoint. */
  public observe(result: ValidateCheckpointResult, opts: { hasRejectedAncestor: boolean }): void {
    // Update the validation result if it has changed, so we can keep track of the first invalid checkpoint
    // in case there is a sequence of more than one invalid checkpoint, as we need to invalidate the first one.
    // There is an exception though: if a checkpoint is invalidated and replaced with another invalid checkpoint,
    // we need to update the validation result, since we need to be able to invalidate the new one.
    // See test 'chain progresses if an invalid checkpoint is invalidated with an invalid one' for more info.
    // Do not update the validation result if there is a rejected ancestor, since in that case we want to keep the
    // original invalidation, as the new checkpoint is extending from a previous invalid one.
    const validStatusChanged = this.current?.valid !== result.valid;
    const invalidStatusWithSameCheckpointNumber =
      !result.valid &&
      this.current &&
      !this.current.valid &&
      this.current.checkpoint.checkpointNumber === result.checkpoint.checkpointNumber;

    if (!opts.hasRejectedAncestor && (validStatusChanged || invalidStatusWithSameCheckpointNumber)) {
      this.current = result;
    }
  }

  /** The status to persist with the current batch, or undefined while it still equals the iteration's initial object. */
  public get update(): ValidateCheckpointResult | undefined {
    return this.current === this.initial ? undefined : this.current;
  }
}
