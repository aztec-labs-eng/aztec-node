import type { Logger } from '@aztec-labs/aztec.js/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import type { CheckpointProposalJobTestEvent, CheckpointProposalJobTestHooks } from '@aztec-labs/sequencer-client';
import type { SubslotSelection } from '@aztec-labs/stdlib/timetable';

/** Milliseconds a held phase may run before the watchdog gives up on the test releasing it. */
const DEFAULT_WATCHDOG_MS = 120_000;

/** Predicate deciding whether a checkpoint phase is the one a test wants to hold. */
export type CheckpointPhasePredicate = (event: CheckpointProposalJobTestEvent) => boolean;

/** Why a hold ended, for the error a step attempted past the end reports. */
type HoldEnd = 'released' | 'watchdog';

/**
 * Thrown by {@link HoldContext.assertStillHeld} when the hold has already ended. `Promise.race` never cancels its
 * loser, so a watchdog that fires mid-hold leaves the test's own work running against a chain the proposer has
 * already resumed building on; every step that mutates L1 or the chain checks first and fails here instead.
 */
export class CheckpointHoldEndedError extends Error {
  constructor(
    public readonly reason: HoldEnd,
    what: string,
  ) {
    super(`Checkpoint hold already ended (${reason}); refusing to ${what}`);
    this.name = 'CheckpointHoldEndedError';
  }
}

/** What a test's held body is handed: the event it matched, the live budgets, and the end-of-hold guard. */
export type HoldContext = {
  /** The phase event the predicate matched. */
  event: CheckpointProposalJobTestEvent;
  /** Aborted the instant the hold ends, for whatever reason. */
  signal: AbortSignal;
  /**
   * Throws {@link CheckpointHoldEndedError} if the hold has already ended. Call it immediately before any step
   * that changes L1 or the chain, so a timed-out hold cannot keep mutating state behind a resumed proposer.
   */
  assertStillHeld(what: string): void;
  /**
   * Milliseconds left before the held block's checkpoint has to be on the wire. Spending this is what makes a
   * released checkpoint miss its own slot, so a test checks it before releasing.
   */
  remainingHoldBudgetMs(now?: number): number;
  /**
   * Where `now` sits in the p2p proposal receive window for this slot, the bound that matters when a released
   * block has to be accepted by peers. `opensInMs` is how long the window still has to open and `closesInMs` how
   * long it has left, so a proposal released now is acceptable exactly when `opensInMs <= 0 < closesInMs`. Both
   * are read from a single `now`, so the two ends cannot be sampled either side of a clock that is moving.
   */
  ingressWindow(now?: number): { opensInMs: number; closesInMs: number };
  /** The sub-slot the proposer's build loop would select on its next iteration, evaluated now. */
  nextSubslot(now?: number): SubslotSelection;
  /**
   * Whether the proposer would go on to build another ordinary block after the held one, evaluated now. The hold
   * has been spending the slot's budget all along, so this is asked of the job rather than read off the snapshot
   * in the event.
   */
  canStartAnotherBlock(now?: number): boolean;
};

/** What an armed gate hands back: the matched event, and the failure channel for the whole held phase. */
export type ArmedCheckpointPhase = {
  /**
   * Resolves with the event the predicate matched. Rejects if the watchdog fires before anything matched, so a
   * consumer is never left waiting on a match that can no longer happen.
   */
  matched: Promise<CheckpointProposalJobTestEvent>;
  /**
   * Rejects if the hold is abandoned: the watchdog fired before {@link CheckpointProposalJobTestGate.release}.
   * Never resolves on its own, so a test races it against its own work to surface a stuck hold as a failure
   * instead of a timeout with no explanation.
   */
  failed: Promise<never>;
  /**
   * Resolves once the gate has released and the job has resumed past the held phase. Rejects with the same error
   * as {@link failed} when the hold was abandoned, so awaiting completion never hides a failure as success.
   */
  completed: Promise<void>;
};

/**
 * Orders real chain operations against checkpoint building in an e2e test.
 *
 * The gate is armed with a predicate, injected into one node as a {@link CheckpointProposalJobTestHooks}, and holds
 * the proposal job at the first phase the predicate matches: the block is signed and in the proposer's archiver, its
 * parent is still available, and neither the network nor the next block has seen it. The test then performs L1 work
 * against that barrier and releases.
 *
 * It only orders; it never suspends protocol time and never sleeps. The held job keeps burning its real proposal
 * deadline, so a test must do bounded, event-driven work inside the hold and check the budgets on its
 * {@link HoldContext} before releasing. Prefer {@link withHold} over {@link arm}: it races the failure channel
 * against the whole body rather than only against the match, releases unconditionally, and hands the body the
 * end-of-hold guard.
 *
 * Lifecycle, all of which the unit tests pin:
 *
 * - one-shot: a matched arming stops holding, so later blocks of the same or a later checkpoint run through;
 * - a second concurrent {@link arm} is rejected rather than silently replacing the first;
 * - {@link release} is idempotent and safe to call when nothing is held, so a test's `finally` can call it blindly;
 * - releasing before anything matched settles the match as a cancellation rather than leaving it pending;
 * - a watchdog before anything matched rejects both `matched` and `completed`, so no consumer waits on a match that
 *   can no longer happen;
 * - a watchdog during a hold rejects `failed` and `completed` and unblocks the job, so a forgotten release cannot
 *   deadlock the suite's teardown while the failure still reaches the test;
 * - `release()` after a watchdog is a no-op: the arming is already settled and reported as failed;
 * - the arming is settled exactly once, so a failure is never later overwritten by a success.
 */
export class CheckpointProposalJobTestGate {
  private arming:
    | {
        predicate: CheckpointPhasePredicate;
        matchedResolve: (event: CheckpointProposalJobTestEvent) => void;
        matchedReject: (err: Error) => void;
        failedReject: (err: Error) => void;
        completedResolve: () => void;
        completedReject: (err: Error) => void;
        /** Set once the predicate matches; from then on the watchdog reports a stuck hold, not a missed phase. */
        held?: CheckpointProposalJobTestEvent;
        releaseHold?: () => void;
        watchdog?: NodeJS.Timeout;
        abort: AbortController;
        settled: boolean;
      }
    | undefined;

  /** How the last arming ended, so a guard called after the fact can say which of the two it was. */
  private lastEnd: HoldEnd = 'released';

  constructor(
    private readonly log: Logger,
    private readonly watchdogMs: number = DEFAULT_WATCHDOG_MS,
  ) {}

  /** The hooks object to inject into a node through `CreateAztecNodeDeps.checkpointProposalJobTestHooks`. */
  public get hooks(): CheckpointProposalJobTestHooks {
    return { onCheckpointPhase: event => this.onCheckpointPhase(event) };
  }

  /** Whether a phase is being held right now. */
  public get isHolding(): boolean {
    return this.arming?.held !== undefined;
  }

  /** The event currently being held, if any. */
  public get heldEvent(): CheckpointProposalJobTestEvent | undefined {
    return this.arming?.held;
  }

  /**
   * Milliseconds left before the held block's checkpoint has to be on the wire. A test asserts this is still enough
   * for the work it has planned after the release, and fails rather than releasing into a deadline it has spent.
   * Undefined when nothing is held.
   *
   * Measured against the proposer's own clock by default, not the wall clock: the e2e date provider runs at an
   * offset, so a wall-clock comparison can report budget left in a slot the proposer has already given up on.
   */
  public remainingHoldBudgetMs(now?: number): number | undefined {
    const held = this.arming?.held;
    return held === undefined ? undefined : held.proposalSendDeadline.getTime() - (now ?? held.schedule.nowMs());
  }

  /**
   * The live budgets and end-of-hold guard for the phase held right now, if any. The same context {@link withHold}
   * hands its body, for a test that armed several gates and only learns which one matched afterwards.
   */
  public heldContext(): HoldContext | undefined {
    const held = this.arming?.held;
    return held === undefined ? undefined : this.makeHoldContext(held);
  }

  /**
   * Holds the first phase matching `predicate`, runs `body` against it, and releases unconditionally.
   *
   * The failure channel is raced against the match *and* against the whole body, so a watchdog that fires halfway
   * through the held work fails the test there rather than being noticed only once the body finishes (or never).
   * `body` receives a {@link HoldContext} whose `assertStillHeld` it must call before each step that changes the
   * chain: the race does not cancel the body, and a resumed proposer must not be mutated behind.
   */
  public async withHold<T>(predicate: CheckpointPhasePredicate, body: (ctx: HoldContext) => Promise<T>): Promise<T> {
    const armed = this.arm(predicate);
    try {
      const event = await Promise.race([armed.matched, armed.failed]);
      return await Promise.race([body(this.makeHoldContext(event)), armed.failed]);
    } finally {
      this.release();
    }
  }

  /**
   * Arms the gate to hold the first checkpoint phase matching `predicate`. Returns the matched event, the failure
   * channel for the hold, and a completion promise that resolves once the job has resumed.
   *
   * Prefer {@link withHold}, which wires the failure channel through the whole held body for you.
   * @throws if the gate is already armed.
   */
  public arm(predicate: CheckpointPhasePredicate): ArmedCheckpointPhase {
    if (this.arming !== undefined) {
      throw new Error('CheckpointProposalJobTestGate is already armed; release the current phase before arming again');
    }
    const matched = promiseWithResolvers<CheckpointProposalJobTestEvent>();
    const failed = promiseWithResolvers<never>();
    const completed = promiseWithResolvers<void>();
    // Nothing may await these before a rejection handler exists, so give them inert ones. Without this, a watchdog
    // that fires while the test is awaiting something else surfaces as an unhandled rejection and kills the run.
    failed.promise.catch(() => {});
    matched.promise.catch(() => {});
    completed.promise.catch(() => {});

    this.arming = {
      predicate,
      matchedResolve: matched.resolve,
      matchedReject: matched.reject,
      failedReject: failed.reject,
      completedResolve: completed.resolve,
      completedReject: completed.reject,
      abort: new AbortController(),
      settled: false,
    };
    this.arming.watchdog = setTimeout(() => this.onWatchdog(), this.watchdogMs);

    return { matched: matched.promise, failed: failed.promise, completed: completed.promise };
  }

  /**
   * Releases a held phase and disarms the gate. Idempotent: calling it when nothing is held, calling it twice, or
   * calling it after the watchdog already failed the arming, does nothing. Safe to call unconditionally from a
   * test's `finally`.
   */
  public release(): void {
    const arming = this.arming;
    if (arming === undefined) {
      return;
    }
    this.disarm('released');
    if (arming.releaseHold === undefined) {
      // Armed but never matched: nothing is holding, so there is nothing to resume. The completion resolves, but
      // the match has to be settled too — a `withHold` body released from elsewhere would otherwise wait for a
      // phase this gate is no longer listening for.
      arming.matchedReject(new Error('CheckpointProposalJobTestGate was released before any checkpoint phase matched'));
      arming.completedResolve();
      return;
    }
    this.log.warn(`Releasing held checkpoint phase`, {
      slot: arming.held?.slot,
      blockNumber: arming.held?.blockNumber,
      indexWithinCheckpoint: arming.held?.indexWithinCheckpoint,
    });
    arming.releaseHold();
  }

  /** The live budgets and end-of-hold guard for the phase currently held, as handed to a {@link withHold} body. */
  private makeHoldContext(event: CheckpointProposalJobTestEvent): HoldContext {
    const arming = this.arming;
    const endReason = (): HoldEnd | undefined =>
      this.arming === arming && arming !== undefined && !arming.settled ? undefined : this.lastEnd;
    return {
      event,
      signal: arming!.abort.signal,
      assertStillHeld: (what: string) => {
        const reason = endReason();
        if (reason !== undefined) {
          throw new CheckpointHoldEndedError(reason, what);
        }
      },
      remainingHoldBudgetMs: (now = event.schedule.nowMs()) => event.proposalSendDeadline.getTime() - now,
      ingressWindow: (now = event.schedule.nowMs()) => ({
        opensInMs: event.schedule.getProposalReceiveStartSeconds() * 1000 - now,
        closesInMs: event.schedule.getProposalReceiveDeadlineSeconds() * 1000 - now,
      }),
      nextSubslot: (now = event.schedule.nowMs()) => event.schedule.selectNextBuildSubslot(now / 1000),
      canStartAnotherBlock: (now = event.schedule.nowMs()) => event.schedule.canBuildAnotherBlock(now / 1000),
    };
  }

  private async onCheckpointPhase(event: CheckpointProposalJobTestEvent): Promise<void> {
    const arming = this.arming;
    if (arming === undefined || arming.held !== undefined || !arming.predicate(event)) {
      return;
    }
    const hold = promiseWithResolvers<void>();
    arming.held = event;
    arming.releaseHold = hold.resolve;
    this.log.warn(`Holding checkpoint phase ${event.phase}`, {
      slot: event.slot,
      checkpointNumber: event.checkpointNumber,
      blockNumber: event.blockNumber,
      indexWithinCheckpoint: event.indexWithinCheckpoint,
      isStandalone: event.isStandalone,
      remainingBuildSubslots: event.remainingBuildSubslots,
      consumedMessageCount: event.consumedMessageCount,
    });
    arming.matchedResolve(event);
    await hold.promise;
    arming.completedResolve();
  }

  /**
   * Fails the arming and unblocks the job. A hold that is never released would otherwise wedge both the sequencer
   * and the suite's teardown, so the watchdog always lets the job go and reports through the failure channel. It
   * rejects `matched` and `completed` alongside `failed`, so no consumer is left awaiting an outcome that can no
   * longer arrive and no failure is hidden behind a resolved completion.
   */
  private onWatchdog(): void {
    const arming = this.arming;
    if (arming === undefined || arming.settled) {
      return;
    }
    const held = arming.held;
    const message =
      held === undefined
        ? `CheckpointProposalJobTestGate timed out after ${this.watchdogMs}ms waiting for a matching checkpoint phase`
        : `CheckpointProposalJobTestGate held ${held.phase} at slot ${held.slot} block ${held.blockNumber} ` +
          `(index ${held.indexWithinCheckpoint}) for ${this.watchdogMs}ms without being released`;
    this.log.error(message);
    this.disarm('watchdog');
    const error = new Error(message);
    arming.failedReject(error);
    arming.matchedReject(error);
    arming.completedReject(error);
    arming.releaseHold?.();
  }

  /** Drops the current arming and its watchdog. The arming object itself is kept alive by whoever holds it. */
  private disarm(reason: HoldEnd): void {
    if (this.arming === undefined) {
      return;
    }
    this.lastEnd = reason;
    this.arming.settled = true;
    this.arming.abort.abort();
    if (this.arming.watchdog !== undefined) {
      clearTimeout(this.arming.watchdog);
    }
    this.arming = undefined;
  }
}
