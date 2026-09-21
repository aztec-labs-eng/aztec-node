import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import type { CheckpointProposalJobTestEvent } from '@aztec-labs/sequencer-client';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { InboxMessagePrefixRef } from '@aztec-labs/stdlib/messaging';
import { ProposerTimetable } from '@aztec-labs/stdlib/timetable';
import { describe, expect, it, jest } from '@jest/globals';

import { CheckpointHoldEndedError, CheckpointProposalJobTestGate } from './checkpoint_proposal_job_test_gate.js';

describe('CheckpointProposalJobTestGate', () => {
  const log = createLogger('e2e:checkpoint-gate-test');

  /**
   * A real {@link ProposerTimetable} on the suites' 36s/6s cadence, so the gate's sub-slot questions are answered by
   * the production scheduler rather than by arithmetic repeated in the test. Genesis is at 0, so slot `n` starts at
   * `n * 36`.
   */
  const timetable = new ProposerTimetable({
    l1Constants: { l1GenesisTime: 0n, slotDuration: 36, ethereumSlotDuration: 12 },
    blockDuration: 6,
    minBlockDuration: 1,
    p2pPropagationTime: 0.5,
    checkpointProposalPrepareTime: 0.5,
    checkpointProposalInitTime: 1,
  });

  const slot = SlotNumber(10);

  const makeEvent = (overrides: Partial<CheckpointProposalJobTestEvent> = {}): CheckpointProposalJobTestEvent => ({
    phase: 'block-ready-to-broadcast',
    slot,
    checkpointNumber: CheckpointNumber(3),
    blockNumber: BlockNumber(7),
    indexWithinCheckpoint: IndexWithinCheckpoint(0),
    blockHash: BlockHash.random(),
    isStandalone: true,
    remainingBuildSubslots: 2,
    subslotIndex: 0,
    proposalSendDeadline: new Date(Date.now() + 30_000),
    consumedMessageCount: 5n,
    inboxPrefixRef: InboxMessagePrefixRef.random(),
    schedule: makeSchedule(0, 4),
    ...overrides,
  });

  /**
   * The scheduling view the job hands the hook, for a block built in `subslotIndex` of a checkpoint capped at
   * `maxBlocks`. Mirrors the job: the loop waits out the sub-slot before re-selecting, so the next selection never
   * happens earlier than that sub-slot's deadline. The job's own unit tests pin that this is what it passes.
   */
  const makeSchedule = (
    subslotIndex: number,
    maxBlocks: number,
    nowMs: () => number = () => Date.now(),
  ): CheckpointProposalJobTestEvent['schedule'] => {
    const deadline = timetable.getBlockBuildDeadline(slot, subslotIndex);
    const next = (nowSeconds: number) => timetable.selectNextSubslot(slot, Math.max(nowSeconds, deadline));
    return {
      nowMs,
      selectNextBuildSubslot: next,
      canBuildAnotherBlock: nowSeconds => {
        if (subslotIndex + 1 >= maxBlocks) {
          return false;
        }
        const selection = next(nowSeconds);
        return selection.canStart && selection.index > subslotIndex;
      },
      getProposalReceiveDeadlineSeconds: () => timetable.getCheckpointProposalReceiveDeadline(slot),
      getProposalReceiveStartSeconds: () => timetable.getCheckpointProposalReceiveStart(slot),
      getAttestationDeadlineSeconds: () => timetable.getAttestationDeadline(slot),
    };
  };

  /** A gate with a watchdog long enough that only the tests that want it will see it fire. */
  const makeGate = (watchdogMs = 60_000) => new CheckpointProposalJobTestGate(log, watchdogMs);

  /** Whether `promise` has settled once the microtask queue has drained, without awaiting it. */
  const isSettled = async (promise: Promise<unknown>) => {
    let settled = false;
    const mark = () => {
      settled = true;
    };
    void promise.then(mark, mark);
    await new Promise(resolve => setImmediate(resolve));
    return settled;
  };

  it('holds only the phase its predicate matches and lets the others through', async () => {
    const gate = makeGate();
    const armed = gate.arm(event => event.indexWithinCheckpoint === 1);

    // A non-matching phase resolves immediately, so the job builds straight through it.
    await gate.hooks.onCheckpointPhase!(makeEvent({ indexWithinCheckpoint: IndexWithinCheckpoint(0) }));
    expect(gate.isHolding).toBe(false);

    const held = makeEvent({ indexWithinCheckpoint: IndexWithinCheckpoint(1), blockNumber: BlockNumber(8) });
    const holding = gate.hooks.onCheckpointPhase!(held);
    expect(await armed.matched).toEqual(held);
    expect(gate.isHolding).toBe(true);
    expect(await isSettled(holding)).toBe(false);

    gate.release();
    await holding;
    await armed.completed;
    expect(gate.isHolding).toBe(false);
  });

  it('stops holding after the first match, so later blocks run through', async () => {
    const gate = makeGate();
    const armed = gate.arm(() => true);

    const first = gate.hooks.onCheckpointPhase!(makeEvent({ blockNumber: BlockNumber(7) }));
    await armed.matched;

    // A concurrent matching phase from another node sharing the gate is not held as well: one arming holds one
    // block, so releasing cannot leave a second job silently stuck.
    const concurrent = gate.hooks.onCheckpointPhase!(makeEvent({ blockNumber: BlockNumber(20) }));
    expect(await isSettled(concurrent)).toBe(true);
    expect(gate.heldEvent?.blockNumber).toEqual(BlockNumber(7));

    gate.release();
    await first;

    // The arming is spent: a later matching phase is not held either.
    await gate.hooks.onCheckpointPhase!(makeEvent({ blockNumber: BlockNumber(8) }));
    expect(gate.isHolding).toBe(false);
    expect(gate.heldEvent).toBeUndefined();
  });

  it('rejects a second concurrent arm rather than replacing the first', async () => {
    const gate = makeGate();
    const armed = gate.arm(() => true);

    expect(() => gate.arm(() => true)).toThrow('already armed');

    const holding = gate.hooks.onCheckpointPhase!(makeEvent());
    await armed.matched;
    gate.release();
    await holding;

    // Once released the gate can be armed again.
    expect(() => gate.arm(() => true)).not.toThrow();
    gate.release();
  });

  it('is idempotent on release, including when nothing was ever held', async () => {
    const gate = makeGate();
    expect(() => gate.release()).not.toThrow();

    const armed = gate.arm(() => true);
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());
    await armed.matched;

    gate.release();
    gate.release();
    await holding;
    await armed.completed;
    expect(gate.isHolding).toBe(false);
  });

  it('completes an arming that is released before anything matched', async () => {
    const gate = makeGate();
    const armed = gate.arm(() => false);

    gate.release();
    await armed.completed;

    // The disarmed gate no longer holds anything, matching predicate or not.
    await gate.hooks.onCheckpointPhase!(makeEvent());
    expect(gate.isHolding).toBe(false);
  });

  it('fails the test and unblocks the job when a hold outlives the watchdog', async () => {
    const gate = makeGate(20);
    const armed = gate.arm(() => true);
    const held = makeEvent({ blockNumber: BlockNumber(9), indexWithinCheckpoint: IndexWithinCheckpoint(1) });

    const holding = gate.hooks.onCheckpointPhase!(held);
    await armed.matched;

    await expect(armed.failed).rejects.toThrow('without being released');
    // The watchdog reports the phase it was stuck on, and the job is let go rather than wedged forever.
    await expect(armed.failed).rejects.toThrow('block 9');
    await holding;
    expect(gate.isHolding).toBe(false);
  });

  it('reports a phase that never arrived separately from a hold that was never released', async () => {
    const gate = makeGate(20);
    const armed = gate.arm(() => false);

    await expect(armed.failed).rejects.toThrow('waiting for a matching checkpoint phase');
  });

  it('does not report a watchdog timeout once the phase has been released', async () => {
    const gate = makeGate(40);
    const armed = gate.arm(() => true);
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());
    await armed.matched;
    gate.release();
    await holding;
    await armed.completed;

    // Past the watchdog deadline the released arming still reports no failure.
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(await isSettled(armed.failed)).toBe(false);
  });

  it('reports the budget left before the held block’s checkpoint has to be sent', async () => {
    const gate = makeGate();
    expect(gate.remainingHoldBudgetMs()).toBeUndefined();

    const armed = gate.arm(() => true);
    const deadline = new Date(1_000_000);
    const holding = gate.hooks.onCheckpointPhase!(makeEvent({ proposalSendDeadline: deadline }));
    await armed.matched;

    expect(gate.remainingHoldBudgetMs(deadline.getTime() - 5_000)).toBe(5_000);
    // A hold that has eaten its own deadline reports a negative budget rather than pretending there is time left.
    expect(gate.remainingHoldBudgetMs(deadline.getTime() + 1_000)).toBe(-1_000);

    gate.release();
    await holding;
  });

  it('does not hold anything before it is armed', async () => {
    const gate = makeGate();
    const hooks = gate.hooks;

    await hooks.onCheckpointPhase!(makeEvent());
    expect(gate.isHolding).toBe(false);
  });

  // A watchdog that fires halfway through a test's held work has to fail that work there. Racing the failure
  // channel against the match alone leaves the body running and the failure unobserved until whatever the body
  // was awaiting eventually times out with no explanation.
  it('surfaces a watchdog timeout that fires while the held body is still running', async () => {
    const gate = makeGate(20);
    const neverResolves = promiseWithResolvers<void>();
    const held = gate.withHold(
      () => true,
      () => neverResolves.promise,
    );
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());

    await expect(held).rejects.toThrow('without being released');
    await holding;
    neverResolves.resolve();
  });

  // Racing does not cancel the body, so the work started inside a hold keeps running after the watchdog let the
  // proposer go. Anything that would change the chain has to refuse instead of racing a resumed proposer.
  it('refuses further chain work from a body that outlived its hold', async () => {
    const gate = makeGate(20);
    const started = promiseWithResolvers<void>();
    const release = promiseWithResolvers<void>();
    let afterTimeout: unknown;

    const held = gate.withHold(
      () => true,
      async ctx => {
        ctx.assertStillHeld('send the first L1 message');
        started.resolve();
        await release.promise;
        try {
          ctx.assertStillHeld('replace the L1 suffix');
        } catch (err) {
          afterTimeout = err;
        }
        expect(ctx.signal.aborted).toBe(true);
      },
    );
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());

    await started.promise;
    await expect(held).rejects.toThrow('without being released');
    release.resolve();
    await holding;
    // The body's own second step, which would have reorged L1 behind a resumed proposer, refused.
    await new Promise(resolve => setImmediate(resolve));
    expect(afterTimeout).toBeInstanceOf(CheckpointHoldEndedError);
    expect((afterTimeout as CheckpointHoldEndedError).reason).toBe('watchdog');
  });

  // The body has to be able to tell "another ordinary block can still be built" from "the final send deadline is
  // open", which are different questions: the send deadline stays open for a whole block sub-slot after the last
  // startable one. Both answers come from the job's scheduling view, not from the snapshot in the event, and a
  // block that finished early must not be told the sub-slot it was built in is the next one available.
  it('answers sub-slot startability from the job schedule rather than the event snapshot', async () => {
    const gate = makeGate();
    const checked = gate.withHold(
      () => true,
      ctx => {
        // The last instant at which the timetable still offers the sub-slot the held block was built in. The
        // proposer waits that sub-slot out before selecting again, so another ordinary block is still ahead even
        // though the timetable asked now would hand back the one already built.
        const early = (timetable.getBlockBuildDeadline(slot, 0) - timetable.minBlockDuration) * 1000;
        expect(timetable.selectNextSubslot(slot, early / 1000).index).toBe(0);
        expect(ctx.nextSubslot(early).index).toBe(1);
        expect(ctx.canStartAnotherBlock(early)).toBe(true);

        // Past the last sub-slot's build deadline no ordinary block is left, even though the snapshot still
        // claimed three and the proposal send deadline has not passed yet.
        const spent = timetable.getBlockBuildDeadline(slot, timetable.getMaxBlocksPerCheckpoint() - 1) * 1000;
        expect(ctx.nextSubslot(spent).canStart).toBe(false);
        expect(ctx.canStartAnotherBlock(spent)).toBe(false);
        expect(ctx.remainingHoldBudgetMs(spent)).toBeGreaterThan(0);
        return Promise.resolve();
      },
    );
    const holding = gate.hooks.onCheckpointPhase!(
      makeEvent({ indexWithinCheckpoint: IndexWithinCheckpoint(0), remainingBuildSubslots: 3 }),
    );
    await checked;
    await holding;
  });

  // The e2e date provider runs at a fixed offset from wall clock, and every deadline the job reports is on that
  // clock. A budget compared against `Date.now()` therefore reports time left in a slot the proposer has already
  // spent — the assertions that guard a release would pass precisely when they should fail.
  it('measures budgets on the proposer’s clock, not the wall clock', async () => {
    const gate = makeGate();
    // The proposer is a full slot ahead of wall clock, and its own clock is past this checkpoint's send deadline.
    const offsetMs = timetable.aztecSlotDuration * 1000;
    const proposerNowMs = () => Date.now() + offsetMs;
    const sendDeadline = new Date(Date.now() + 1_000);

    const checked = gate.withHold(
      () => true,
      ctx => {
        expect(ctx.remainingHoldBudgetMs()).toBeLessThan(0);
        expect(gate.remainingHoldBudgetMs()).toBeLessThan(0);
        // The wall clock still claims a second of budget, which is the answer that used to be reported.
        expect(ctx.remainingHoldBudgetMs(Date.now())).toBeGreaterThan(0);
        return Promise.resolve();
      },
    );
    const holding = gate.hooks.onCheckpointPhase!(
      makeEvent({ proposalSendDeadline: sendDeadline, schedule: makeSchedule(0, 4, proposerNowMs) }),
    );
    await checked;
    await holding;
  });

  // A `withHold` body released from outside — a suite-level `afterEach` that blindly releases, say — must settle
  // rather than wait for a phase the gate has stopped listening for.
  it('settles a hold whose gate is released before anything matched', async () => {
    const gate = makeGate();
    const held = gate.withHold(
      () => false,
      () => Promise.resolve('unreachable'),
    );

    gate.release();
    await expect(held).rejects.toThrow('released before any checkpoint phase matched');
  });

  // The stale-block scenarios release a signed block that peers still have to accept on ingress, which the
  // proposal send deadline does not bound: it is one propagation budget earlier than the consensus receive
  // deadline validators actually enforce.
  it('reports the ingress window separately from the proposal send budget', async () => {
    const gate = makeGate();
    const receiveDeadline = timetable.getCheckpointProposalReceiveDeadline(slot);
    const sendDeadline = receiveDeadline - timetable.p2pPropagationTime;
    const checked = gate.withHold(
      () => true,
      ctx => {
        const now = (sendDeadline - 1) * 1000;
        expect(ctx.remainingHoldBudgetMs(now)).toBe(1000);
        expect(ctx.ingressWindow(now).closesInMs).toBe(1000 + timetable.p2pPropagationTime * 1000);
        return Promise.resolve();
      },
    );
    const holding = gate.hooks.onCheckpointPhase!(makeEvent({ proposalSendDeadline: new Date(sendDeadline * 1000) }));
    await checked;
    await holding;
  });

  // Peers gate proposal ingress on both ends of the receive window, so a release is only safe once the window has
  // opened. A test that measured only the deadline read a healthy budget while its proposal was still too early to
  // be accepted, and the block was dropped at gossip instead of being compared. Both bounds come from one `now`,
  // so a caller cannot sample them either side of a clock that is moving.
  it('reports how long the ingress window is still to open', async () => {
    const gate = makeGate();
    const receiveStart = timetable.getCheckpointProposalReceiveStart(slot);
    const checked = gate.withHold(
      () => true,
      ctx => {
        const receiveDeadline = timetable.getCheckpointProposalReceiveDeadline(slot);
        const tooEarly = (receiveStart - 12) * 1000;
        expect(ctx.ingressWindow(tooEarly).opensInMs).toBe(12_000);
        expect(ctx.ingressWindow(tooEarly).closesInMs).toBe((receiveDeadline - receiveStart + 12) * 1000);
        expect(ctx.ingressWindow(receiveStart * 1000).opensInMs).toBe(0);
        expect(ctx.ingressWindow((receiveStart + 1) * 1000).opensInMs).toBe(-1000);
        // The strict window is inclusive at the deadline, which is why the helper's contract is "<= 0 < closes"
        // rather than a claim about what peers accept: they widen this by their clock-disparity tolerance.
        expect(ctx.ingressWindow(receiveDeadline * 1000).closesInMs).toBe(0);
        return Promise.resolve();
      },
    );
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());
    await checked;
    await holding;
  });

  // A watchdog that fires before anything matched used to leave `matched` and `completed` pending forever, so a
  // test awaiting either hung until jest's own timeout rather than reporting the gate's diagnosis.
  it('does not leave consumers waiting on a match that can no longer happen', async () => {
    const gate = makeGate(20);
    const armed = gate.arm(() => false);

    await expect(armed.matched).rejects.toThrow('waiting for a matching checkpoint phase');
    await expect(armed.completed).rejects.toThrow('waiting for a matching checkpoint phase');
  });

  // A hold abandoned by the watchdog must not look like a clean completion to anything awaiting the phase to
  // resume, or the test continues past a barrier that was never honored.
  it('fails the completion channel when a hold is abandoned rather than resolving it', async () => {
    const gate = makeGate(20);
    const armed = gate.arm(() => true);
    const holding = gate.hooks.onCheckpointPhase!(makeEvent());
    await armed.matched;

    await expect(armed.completed).rejects.toThrow('without being released');
    await holding;

    // Releasing after the watchdog already settled the arming changes nothing.
    gate.release();
    await expect(armed.completed).rejects.toThrow('without being released');
  });

  afterEach(() => {
    jest.useRealTimers();
  });
});
