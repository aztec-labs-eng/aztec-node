import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { createLogger } from '@aztec-labs/foundation/log';
import type { CheckpointProposalJobTestEvent } from '@aztec-labs/sequencer-client';
import { BlockHash } from '@aztec-labs/stdlib/block';
import { InboxMessagePrefixRef } from '@aztec-labs/stdlib/messaging';
import { describe, expect, it, jest } from '@jest/globals';

import { CheckpointProposalJobTestGate } from './checkpoint_proposal_job_test_gate.js';

describe('CheckpointProposalJobTestGate', () => {
  const log = createLogger('e2e:checkpoint-gate-test');

  const makeEvent = (overrides: Partial<CheckpointProposalJobTestEvent> = {}): CheckpointProposalJobTestEvent => ({
    phase: 'block-ready-to-broadcast',
    slot: SlotNumber(10),
    checkpointNumber: CheckpointNumber(3),
    blockNumber: BlockNumber(7),
    indexWithinCheckpoint: IndexWithinCheckpoint(0),
    blockHash: BlockHash.random(),
    isStandalone: true,
    remainingBuildSubslots: 2,
    proposalSendDeadline: new Date(Date.now() + 30_000),
    consumedMessageCount: 5n,
    inboxPrefixRef: InboxMessagePrefixRef.random(),
    ...overrides,
  });

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

  afterEach(() => {
    jest.useRealTimers();
  });
});
