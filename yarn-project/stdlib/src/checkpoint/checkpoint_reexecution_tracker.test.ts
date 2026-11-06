import { CheckpointNumber, CheckpointProposalHash, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { times } from '@aztec-labs/foundation/collection';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { TxHash } from '../tx/tx_hash.js';
import { CheckpointReexecutionTracker } from './checkpoint_reexecution_tracker.js';

describe('CheckpointReexecutionTracker', () => {
  let tracker: CheckpointReexecutionTracker;

  beforeEach(() => {
    tracker = new CheckpointReexecutionTracker();
  });

  it('records and queries `valid` outcomes by (checkpoint number, archive root)', () => {
    const cp = CheckpointNumber(7);
    const archive = Fr.random();
    tracker.recordOutcome(SlotNumber(42), archive, 'valid', cp);

    expect(tracker.hasReexecuted(cp, archive)).toBe(true);
    expect(tracker.hasReexecuted(cp, Fr.random())).toBe(false);
    expect(tracker.hasReexecuted(CheckpointNumber(8), archive)).toBe(false);
  });

  it('hasReexecuted is true only for `valid` outcomes', () => {
    const cp = CheckpointNumber(1);
    const archive = Fr.random();

    tracker.recordOutcome(SlotNumber(1), archive, 'invalid', cp);
    expect(tracker.hasReexecuted(cp, archive)).toBe(false);

    tracker.recordOutcome(SlotNumber(1), archive, 'unvalidated', cp);
    expect(tracker.hasReexecuted(cp, archive)).toBe(false);

    tracker.recordOutcome(SlotNumber(1), archive, 'valid', cp);
    expect(tracker.hasReexecuted(cp, archive)).toBe(true);
  });

  // The caller that needs this has no checkpoint number: revalidating a cached verdict after the checkpoint's last
  // block was pruned fails before the blocks are loaded, so slot and archive are all it can ask with.
  it('answers whether a slot holds a `valid` outcome for an archive, without a checkpoint number', () => {
    const slot = SlotNumber(42);
    const archive = Fr.random();
    tracker.recordOutcome(slot, archive, 'valid', CheckpointNumber(7));

    expect(tracker.hasValidOutcomeForSlot(slot, archive)).toBe(true);
    // A different archive at the same slot is a different question, and a different slot is not this one.
    expect(tracker.hasValidOutcomeForSlot(slot, Fr.random())).toBe(false);
    expect(tracker.hasValidOutcomeForSlot(SlotNumber(43), archive)).toBe(false);
  });

  it.each(['invalid', 'unvalidated'] as const)('does not report a `%s` slot outcome as valid', outcome => {
    const slot = SlotNumber(1);
    const archive = Fr.random();
    tracker.recordOutcome(slot, archive, outcome, CheckpointNumber(1));

    expect(tracker.hasValidOutcomeForSlot(slot, archive)).toBe(false);
  });

  it('exposes outcomes by slot', () => {
    tracker.recordOutcome(SlotNumber(10), Fr.random(), 'valid', CheckpointNumber(1));
    tracker.recordOutcome(SlotNumber(20), Fr.random(), 'invalid', CheckpointNumber(2));
    tracker.recordOutcome(SlotNumber(30), Fr.random(), 'unvalidated', CheckpointNumber(3));

    expect(tracker.getOutcomeForSlot(SlotNumber(10))).toBe('valid');
    expect(tracker.getOutcomeForSlot(SlotNumber(20))).toBe('invalid');
    expect(tracker.getOutcomeForSlot(SlotNumber(30))).toBe('unvalidated');
    expect(tracker.getOutcomeForSlot(SlotNumber(99))).toBeUndefined();
  });

  it('returns the full record for a slot, including the parent archive root and payload hash', () => {
    const slot = SlotNumber(42);
    const archive = Fr.random();
    const lastArchive = Fr.random();
    const payloadHash = CheckpointProposalHash(Fr.random().toString());
    tracker.recordOutcome(slot, archive, 'valid', CheckpointNumber(7), { lastArchiveRoot: lastArchive, payloadHash });

    expect(tracker.getRecordForSlot(slot)).toEqual({
      outcome: 'valid',
      checkpointNumber: CheckpointNumber(7),
      archiveRoot: archive.toString(),
      lastArchiveRoot: lastArchive.toString(),
      payloadHash,
    });
    expect(tracker.getRecordForSlot(SlotNumber(43))).toBeUndefined();
  });

  it('returns a record without parent archive root when none was recorded', () => {
    const slot = SlotNumber(42);
    const archive = Fr.random();
    tracker.recordOutcome(slot, archive, 'unvalidated');

    expect(tracker.getRecordForSlot(slot)).toEqual({
      outcome: 'unvalidated',
      checkpointNumber: undefined,
      archiveRoot: archive.toString(),
      lastArchiveRoot: undefined,
    });
  });

  it('returns no record for a slot that only has tx-collection or equivocation data', () => {
    tracker.recordTxsCollected(SlotNumber(1), [TxHash.random()]);
    tracker.recordEquivocation(SlotNumber(2));

    expect(tracker.getRecordForSlot(SlotNumber(1))).toBeUndefined();
    expect(tracker.getRecordForSlot(SlotNumber(2))).toBeUndefined();
  });

  it('records and queries proposal equivocation by slot', () => {
    expect(tracker.hasEquivocation(SlotNumber(7))).toBe(false);

    tracker.recordEquivocation(SlotNumber(7));
    expect(tracker.hasEquivocation(SlotNumber(7))).toBe(true);
    // Unrelated slots are unaffected.
    expect(tracker.hasEquivocation(SlotNumber(8))).toBe(false);
  });

  it('preserves equivocation across a later recordOutcome for the same slot', () => {
    tracker.recordEquivocation(SlotNumber(5));
    tracker.recordOutcome(SlotNumber(5), Fr.random(), 'valid', CheckpointNumber(1));

    expect(tracker.hasEquivocation(SlotNumber(5))).toBe(true);
    expect(tracker.getOutcomeForSlot(SlotNumber(5))).toBe('valid');
  });

  it('records slot-only outcomes when checkpoint number is unknown', () => {
    const archive = Fr.random();
    tracker.recordOutcome(SlotNumber(5), archive, 'invalid');

    expect(tracker.getOutcomeForSlot(SlotNumber(5))).toBe('invalid');
    expect(tracker.hasReexecuted(CheckpointNumber(0), archive)).toBe(false);
  });

  it('tracks competing archive roots at the same checkpoint independently', () => {
    const cp = CheckpointNumber(5);
    const archiveA = Fr.random();
    const archiveB = Fr.random();

    tracker.recordOutcome(SlotNumber(50), archiveB, 'invalid', cp);
    tracker.recordOutcome(SlotNumber(51), archiveA, 'valid', cp);

    expect(tracker.hasReexecuted(cp, archiveA)).toBe(true);
    expect(tracker.hasReexecuted(cp, archiveB)).toBe(false);
  });

  it('removeBefore drops entries below the cutoff and clears their slot index', () => {
    tracker.recordOutcome(SlotNumber(10), Fr.random(), 'valid', CheckpointNumber(1));
    tracker.recordOutcome(SlotNumber(20), Fr.random(), 'valid', CheckpointNumber(2));
    tracker.recordOutcome(SlotNumber(30), Fr.random(), 'valid', CheckpointNumber(3));

    tracker.removeBefore(CheckpointNumber(3));

    expect(tracker.getOutcomeForSlot(SlotNumber(10))).toBeUndefined();
    expect(tracker.getOutcomeForSlot(SlotNumber(20))).toBeUndefined();
    expect(tracker.getOutcomeForSlot(SlotNumber(30))).toBe('valid');
  });

  it('overwrites a prior outcome for the same (checkpoint, archive)', () => {
    const cp = CheckpointNumber(1);
    const archive = Fr.random();
    tracker.recordOutcome(SlotNumber(1), archive, 'unvalidated', cp);
    tracker.recordOutcome(SlotNumber(1), archive, 'valid', cp);

    expect(tracker.hasReexecuted(cp, archive)).toBe(true);
    expect(tracker.getOutcomeForSlot(SlotNumber(1))).toBe('valid');
  });

  it('removeBefore drops slot-only entries older than the highest removed slot', () => {
    // Slot-only entries (no checkpoint number) cannot be reached via byCheckpoint pruning.
    // Without slot-watermark pruning they would accumulate forever.
    tracker.recordOutcome(SlotNumber(5), Fr.random(), 'unvalidated');
    tracker.recordOutcome(SlotNumber(10), Fr.random(), 'valid', CheckpointNumber(1));
    tracker.recordOutcome(SlotNumber(12), Fr.random(), 'unvalidated');
    tracker.recordOutcome(SlotNumber(20), Fr.random(), 'valid', CheckpointNumber(2));
    tracker.recordOutcome(SlotNumber(25), Fr.random(), 'unvalidated');

    tracker.removeBefore(CheckpointNumber(2));

    expect(tracker.getOutcomeForSlot(SlotNumber(5))).toBeUndefined();
    expect(tracker.getOutcomeForSlot(SlotNumber(10))).toBeUndefined();
    // Slot 12 is above the highest removed slot (10)
    expect(tracker.getOutcomeForSlot(SlotNumber(12))).toBe('unvalidated');
    expect(tracker.getOutcomeForSlot(SlotNumber(20))).toBe('valid');
    expect(tracker.getOutcomeForSlot(SlotNumber(25))).toBe('unvalidated');
  });

  describe('recordTxsCollected', () => {
    const txs = (n: number) => times(n, () => TxHash.random());

    it('vouches only for the exact tx list collected at that slot', () => {
      const collected = txs(2);
      tracker.recordTxsCollected(SlotNumber(11), collected);

      expect(tracker.hasCollectedTxs(SlotNumber(11), collected)).toBe(true);
      expect(tracker.hasCollectedTxs(SlotNumber(11), [...collected].reverse())).toBe(false);
      expect(tracker.hasCollectedTxs(SlotNumber(11), collected.slice(0, 1))).toBe(false);
      expect(tracker.hasCollectedTxs(SlotNumber(11), txs(2))).toBe(false);
      expect(tracker.hasCollectedTxs(SlotNumber(12), collected)).toBe(false);
    });

    it('does not vouch for txs it never recorded as collected', () => {
      expect(tracker.hasCollectedTxs(SlotNumber(11), txs(2))).toBe(false);
      expect(tracker.hasCollectedTxs(SlotNumber(11), [])).toBe(false);
    });

    it('keeps every tx list collected for the same slot', () => {
      const first = txs(2);
      const second = txs(3);
      tracker.recordTxsCollected(SlotNumber(11), first);
      tracker.recordTxsCollected(SlotNumber(11), second);

      expect(tracker.hasCollectedTxs(SlotNumber(11), first)).toBe(true);
      expect(tracker.hasCollectedTxs(SlotNumber(11), second)).toBe(true);
    });

    it('preserves collected tx lists when recordOutcome fires for the same slot', () => {
      const collected = txs(2);
      tracker.recordTxsCollected(SlotNumber(11), collected);

      tracker.recordOutcome(SlotNumber(11), Fr.random(), 'valid', CheckpointNumber(7));

      expect(tracker.hasCollectedTxs(SlotNumber(11), collected)).toBe(true);
      expect(tracker.getOutcomeForSlot(SlotNumber(11))).toBe('valid');
    });

    it('removeBefore drops collected tx lists together with their slot', () => {
      const atSlot10 = txs(1);
      const atSlot20 = txs(1);
      tracker.recordTxsCollected(SlotNumber(10), atSlot10);
      tracker.recordOutcome(SlotNumber(10), Fr.random(), 'valid', CheckpointNumber(1));
      tracker.recordTxsCollected(SlotNumber(20), atSlot20);
      tracker.recordOutcome(SlotNumber(20), Fr.random(), 'valid', CheckpointNumber(2));

      tracker.removeBefore(CheckpointNumber(2));

      expect(tracker.hasCollectedTxs(SlotNumber(10), atSlot10)).toBe(false);
      expect(tracker.hasCollectedTxs(SlotNumber(20), atSlot20)).toBe(true);
    });

    it('removeBefore drops standalone collected tx lists via the slot watermark', () => {
      // recordTxsCollected without a subsequent recordOutcome creates a slot-only entry with
      // no checkpoint number; it must still be reachable by the slot-watermark cleanup.
      const atSlot5 = txs(1);
      const atSlot12 = txs(1);
      tracker.recordTxsCollected(SlotNumber(5), atSlot5);
      tracker.recordOutcome(SlotNumber(10), Fr.random(), 'valid', CheckpointNumber(1));
      tracker.recordTxsCollected(SlotNumber(12), atSlot12);
      tracker.recordOutcome(SlotNumber(20), Fr.random(), 'valid', CheckpointNumber(2));

      tracker.removeBefore(CheckpointNumber(2));

      expect(tracker.hasCollectedTxs(SlotNumber(5), atSlot5)).toBe(false);
      // Slot 12 is above the highest removed slot (10), so it survives.
      expect(tracker.hasCollectedTxs(SlotNumber(12), atSlot12)).toBe(true);
      expect(tracker.getOutcomeForSlot(SlotNumber(20))).toBe('valid');
    });
  });
});
