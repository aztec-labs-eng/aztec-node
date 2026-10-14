import { type PromiseWithResolvers, promiseWithResolvers } from '../promise/index.js';
import { Semaphore } from './semaphore.js';

/**
 * A readers-writer lock: any number of shared holders at once, or one exclusive holder with no shared holder alongside.
 *
 * Exclusive holders take turns in the order they asked. Only the exclusive holder whose turn it is holds back new
 * shared holders, not those still waiting for theirs, so shared holders that asked during a turn get in between it and
 * the next one.
 */
export class ReadWriteLock {
  /** Gives exclusive holders their turns, one at a time, in the order they asked. */
  private readonly exclusiveTurns = new Semaphore(1);
  /** Set while an exclusive holder has its turn, holding back new shared holders; settles when the turn ends. */
  private exclusiveTurn: Promise<void> | undefined;
  private sharedHolders = 0;
  /** Resolved when the last shared holder finishes, for an exclusive holder waiting to start its turn. */
  private sharedDrained: PromiseWithResolvers<void> | undefined;

  /** Runs `fn` alongside any other shared holders, once no exclusive holder has its turn. */
  public async runShared<T>(fn: () => Promise<T>): Promise<T> {
    while (this.exclusiveTurn) {
      await this.exclusiveTurn;
    }
    this.sharedHolders++;
    try {
      return await fn();
    } finally {
      if (--this.sharedHolders === 0) {
        this.sharedDrained?.resolve();
      }
    }
  }

  /** Runs `fn` with no other holder: after the exclusive holders that asked before it and the shared ones running. */
  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.exclusiveTurns.acquire();
    const turn = promiseWithResolvers<void>();
    this.exclusiveTurn = turn.promise;
    try {
      if (this.sharedHolders > 0) {
        this.sharedDrained = promiseWithResolvers<void>();
        await this.sharedDrained.promise;
        this.sharedDrained = undefined;
      }
      return await fn();
    } finally {
      this.exclusiveTurn = undefined;
      turn.resolve();
      this.exclusiveTurns.release();
    }
  }
}
