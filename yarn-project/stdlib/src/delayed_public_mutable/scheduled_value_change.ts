import { minBigint } from '@aztec-labs/foundation/bigint';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import type { UInt64 } from '../types/shared.js';

export class ScheduledValueChange {
  constructor(
    public previous: Fr[],
    public post: Fr[],
    public timestampOfChange: UInt64,
  ) {
    if (this.previous.length !== this.post.length) {
      throw new Error('Previous and post must have the same length');
    }
  }

  static empty(valueSize: number) {
    return new this(Array(valueSize).fill(new Fr(0)), Array(valueSize).fill(new Fr(0)), 0n);
  }

  isEmpty(): boolean {
    return this.previous.every(v => v.isZero()) && this.post.every(v => v.isZero()) && this.timestampOfChange === 0n;
  }

  getCurrentAt(timestamp: UInt64) {
    if (timestamp < this.timestampOfChange) {
      return this.previous;
    } else {
      return this.post;
    }
  }

  /**
   * Returns the last timestamp at which the value current at `anchorBlockTimestamp` is guaranteed to still be current,
   * given the `minimumDelay` (from {@link ScheduledDelayChange.getEffectiveMinimumDelayAt}) for a newly scheduled change.
   */
  getTimeHorizon(anchorBlockTimestamp: UInt64, minimumDelay: UInt64): UInt64 {
    const delayHorizon = anchorBlockTimestamp + minimumDelay;
    // A change that already took effect, or one that keeps the same value (e.g. a cancellation), cannot change the
    // current value, so only a change scheduled after the anchor block limits the horizon.
    const keepsValue = this.previous.every((value, i) => value.equals(this.post[i]));
    if (anchorBlockTimestamp >= this.timestampOfChange || keepsValue) {
      return delayHorizon;
    }
    const changeHorizon = this.timestampOfChange - 1n;
    return minBigint(changeHorizon, delayHorizon);
  }
}
