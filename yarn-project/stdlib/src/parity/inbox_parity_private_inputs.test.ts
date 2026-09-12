import {
  INBOX_PARITY_SIZE_LARGE,
  INBOX_PARITY_SIZE_MEDIUM,
  INBOX_PARITY_SIZE_SMALL,
  INBOX_PARITY_SIZE_XSMALL,
  INBOX_PARITY_SIZE_XXSMALL,
  MAX_L1_TO_L2_MSGS_PER_BLOCK,
  MAX_L1_TO_L2_MSGS_PER_CHECKPOINT,
} from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { describe, expect, it } from '@jest/globals';

import { INBOX_PARITY_SIZES, InboxParityPrivateInputs, pickInboxParitySize } from './inbox_parity_private_inputs.js';

describe('InboxParity size dispatch', () => {
  // The ladder rungs are the circuit variants that exist; the dispatcher may never name a size that has no VK.
  it('is a strictly ascending ladder of the generated circuit sizes', () => {
    expect([...INBOX_PARITY_SIZES]).toEqual([
      INBOX_PARITY_SIZE_XXSMALL,
      INBOX_PARITY_SIZE_XSMALL,
      INBOX_PARITY_SIZE_SMALL,
      INBOX_PARITY_SIZE_MEDIUM,
      INBOX_PARITY_SIZE_LARGE,
    ]);
    expect([...INBOX_PARITY_SIZES]).toEqual([...INBOX_PARITY_SIZES].sort((a, b) => a - b));
    // The largest rung has to cover a full checkpoint, or a legal checkpoint could not be proven at all.
    expect(INBOX_PARITY_SIZE_LARGE).toEqual(MAX_L1_TO_L2_MSGS_PER_CHECKPOINT);
    // The block cap is itself a rung, so a full block's messages never force the next circuit up.
    expect([...INBOX_PARITY_SIZES]).toContain(MAX_L1_TO_L2_MSGS_PER_BLOCK);
  });

  // Every rung boundary, from both sides: the count that still fits and the one that moves to the next circuit.
  it.each([
    [0, INBOX_PARITY_SIZE_XXSMALL],
    [1, INBOX_PARITY_SIZE_XXSMALL],
    [4, INBOX_PARITY_SIZE_XXSMALL],
    [5, INBOX_PARITY_SIZE_XSMALL],
    [16, INBOX_PARITY_SIZE_XSMALL],
    [17, INBOX_PARITY_SIZE_SMALL],
    [64, INBOX_PARITY_SIZE_SMALL],
    [65, INBOX_PARITY_SIZE_MEDIUM],
    [255, INBOX_PARITY_SIZE_MEDIUM],
    [256, INBOX_PARITY_SIZE_MEDIUM],
    [257, INBOX_PARITY_SIZE_LARGE],
    [1023, INBOX_PARITY_SIZE_LARGE],
    [1024, INBOX_PARITY_SIZE_LARGE],
  ])('picks the %i-message circuit of size %i', (numMessages, expected) => {
    expect(pickInboxParitySize(numMessages)).toEqual(expected);
  });

  it('rejects a count above the largest rung', () => {
    expect(() => pickInboxParitySize(INBOX_PARITY_SIZE_LARGE + 1)).toThrow(
      `Cannot fit 1025 L1-to-L2 messages into any InboxParity size (max ${INBOX_PARITY_SIZE_LARGE})`,
    );
  });
});

describe('InboxParityPrivateInputs.fromMessages', () => {
  const messages = (count: number) => Array.from({ length: count }, (_, i) => new Fr(i + 1));
  const startRollingHash = new Fr(7);
  const proverId = new Fr(11);

  // Input construction has to agree with the dispatcher at every boundary, pad to exactly the chosen size, and keep
  // the real messages ahead of the padding: the circuit reads the first `numMessages` leaves and nothing else.
  it.each([0, 1, 4, 5, 16, 17, 64, 65, 255, 256, 257, 1023, 1024])(
    'builds inputs for %i messages at the size the dispatcher picks',
    numMessages => {
      const real = messages(numMessages);
      const inputs = InboxParityPrivateInputs.fromMessages(real, startRollingHash, proverId);

      const size = pickInboxParitySize(numMessages);
      expect(inputs.size).toEqual(size);
      expect(inputs.numMessages).toEqual(numMessages);
      expect(inputs.messages).toHaveLength(size);
      expect(inputs.messages.slice(0, numMessages)).toEqual(real);
      expect(inputs.messages.slice(numMessages)).toEqual(Array(size - numMessages).fill(Fr.ZERO));
      expect(inputs.startRollingHash).toEqual(startRollingHash);
      expect(inputs.proverId).toEqual(proverId);
    },
  );

  // 1025 is one past the per-checkpoint cap, so no checkpoint may ever reach it. Construction refuses rather than
  // silently truncating to the largest circuit.
  it('rejects a message set one above the per-checkpoint cap', () => {
    expect(() => InboxParityPrivateInputs.fromMessages(messages(1025), startRollingHash, proverId)).toThrow(
      'Cannot fit 1025 L1-to-L2 messages',
    );
  });

  it('rejects a message array that does not match its declared size', () => {
    expect(
      () => new InboxParityPrivateInputs(INBOX_PARITY_SIZE_SMALL, messages(63), 63, startRollingHash, proverId),
    ).toThrow('must equal size');
  });

  it.each([0, 65, 257])('round-trips %i-message inputs through a buffer', numMessages => {
    const inputs = InboxParityPrivateInputs.fromMessages(messages(numMessages), startRollingHash, proverId);
    expect(InboxParityPrivateInputs.fromBuffer(inputs.toBuffer())).toEqual(inputs);
    expect(InboxParityPrivateInputs.fromString(inputs.toString())).toEqual(inputs);
  });
});
