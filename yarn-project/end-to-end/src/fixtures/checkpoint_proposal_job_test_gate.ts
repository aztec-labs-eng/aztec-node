import type { Logger } from '@aztec-labs/aztec.js/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import type { CheckpointProposalJobTestEvent, CheckpointProposalJobTestHooks } from '@aztec-labs/sequencer-client';

/** Milliseconds a held phase may run before the watchdog gives up on the test releasing it. */
const DEFAULT_WATCHDOG_MS = 120_000;

/** Predicate deciding whether a checkpoint phase is the one a test wants to hold. */
export type CheckpointPhasePredicate = (event: CheckpointProposalJobTestEvent) => boolean;

/** What an armed gate hands back: the matched event, and the failure channel for the whole held phase. */
export type ArmedCheckpointPhase = {
  /** Resolves with the event the predicate matched, once the job reaches it. */
  matched: Promise<CheckpointProposalJobTestEvent>;
  /**
   * Rejects if the hold is abandoned: the watchdog fired before {@link CheckpointProposalJobTestGate.release}, or the
   * arming was disposed while still holding. Never resolves on its own, so a test races it against its own work to
   * surface a stuck hold as a failure instead of a timeout with no explanation.
   */
  failed: Promise<never>;
  /** Resolves once the gate has released and the job has resumed past the held phase. */
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
 * deadline, so a test must do bounded, event-driven work inside the hold and check {@link remainingHoldBudgetMs}
 * before releasing.
 *
 * Lifecycle rules, all of which the unit tests pin:
 *
 * - one-shot: a matched arming stops holding, so later blocks of the same or a later checkpoint run through;
 * - a second concurrent {@link arm} is rejected rather than silently replacing the first;
 * - {@link release} is idempotent and safe to call when nothing is held, so a test's `finally` can call it blindly;
 * - the watchdog both fails the test through {@link ArmedCheckpointPhase.failed} and unblocks the job, so a forgotten
 *   release cannot deadlock the suite's teardown;
 * - once the phase has matched, the arming's failure channel can no longer report a watchdog timeout against it.
 */
export class CheckpointProposalJobTestGate {
  private arming:
    | {
        predicate: CheckpointPhasePredicate;
        matchedResolve: (event: CheckpointProposalJobTestEvent) => void;
        failedReject: (err: Error) => void;
        completedResolve: () => void;
        /** Set once the predicate matches; from then on the watchdog reports a stuck hold, not a missed phase. */
        held?: CheckpointProposalJobTestEvent;
        releaseHold?: () => void;
        watchdog?: NodeJS.Timeout;
        settled: boolean;
      }
    | undefined;

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
   */
  public remainingHoldBudgetMs(now: number = Date.now()): number | undefined {
    const held = this.arming?.held;
    return held === undefined ? undefined : held.proposalSendDeadline.getTime() - now;
  }

  /**
   * Arms the gate to hold the first checkpoint phase matching `predicate`. Returns the matched event, the failure
   * channel for the hold, and a completion promise that resolves once the job has resumed.
   * @throws if the gate is already armed.
   */
  public arm(predicate: CheckpointPhasePredicate): ArmedCheckpointPhase {
    if (this.arming !== undefined) {
      throw new Error('CheckpointProposalJobTestGate is already armed; release the current phase before arming again');
    }
    const matched = promiseWithResolvers<CheckpointProposalJobTestEvent>();
    const failed = promiseWithResolvers<never>();
    const completed = promiseWithResolvers<void>();
    // Nothing may await `failed` before a rejection handler exists, so give it an inert one.
    failed.promise.catch(() => {});

    this.arming = {
      predicate,
      matchedResolve: matched.resolve,
      failedReject: failed.reject,
      completedResolve: completed.resolve,
      settled: false,
    };
    this.arming.watchdog = setTimeout(() => this.onWatchdog(), this.watchdogMs);

    return { matched: matched.promise, failed: failed.promise, completed: completed.promise };
  }

  /**
   * Releases a held phase and disarms the gate. Idempotent: calling it when nothing is held, or calling it twice,
   * does nothing. Safe to call unconditionally from a test's `finally`.
   */
  public release(): void {
    const arming = this.arming;
    if (arming === undefined) {
      return;
    }
    this.disarm();
    if (arming.releaseHold === undefined) {
      // Armed but never matched: nothing is holding, so there is nothing to resume and no failure to report.
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
   * and the suite's teardown, so the watchdog always lets the job go and reports through the failure channel.
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
    this.disarm();
    arming.failedReject(new Error(message));
    arming.releaseHold?.();
  }

  /** Drops the current arming and its watchdog. The arming object itself is kept alive by whoever holds it. */
  private disarm(): void {
    if (this.arming === undefined) {
      return;
    }
    this.arming.settled = true;
    if (this.arming.watchdog !== undefined) {
      clearTimeout(this.arming.watchdog);
    }
    this.arming = undefined;
  }
}
