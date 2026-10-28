import { minBigint } from '@aztec-labs/foundation/bigint';

import type { UInt64 } from '../types/shared.js';

export class ScheduledDelayChange {
  constructor(
    public pre: UInt64 | undefined,
    public post: UInt64 | undefined,
    public timestampOfChange: UInt64,
  ) {}

  static empty() {
    return new this(undefined, undefined, 0n);
  }

  isEmpty(): boolean {
    return this.pre === undefined && this.post === undefined && this.timestampOfChange === 0n;
  }

  /**
   * Returns how many seconds after `anchorBlockTimestamp` a value read at that anchor block is guaranteed to remain
   * current, considering any scheduled delay change. `initialDelay` is the delay in effect before any change to it.
   *
   * This is one second less than the earliest time after the anchor at which a value change could take effect: a block
   * sharing the anchor's timestamp can schedule a change, and the change is in effect at its own timestamp.
   */
  getEffectiveMinimumDelayAt(anchorBlockTimestamp: UInt64, initialDelay: UInt64): UInt64 {
    if (this.timestampOfChange <= anchorBlockTimestamp) {
      return (this.post ?? initialDelay) - 1n;
    }
    // A pending delay reduction can let a value change land sooner than the current delay would. The current delay
    // still bounds it, since the pending delay change might be cancelled before it takes effect.
    const timeUntilDelayChange = this.timestampOfChange - anchorBlockTimestamp;
    const currentDelay = this.pre ?? initialDelay;
    const delayAfterChange = timeUntilDelayChange + (this.post ?? initialDelay);
    return minBigint(currentDelay, delayAfterChange) - 1n;
  }
}
