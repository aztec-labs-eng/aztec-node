import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { describe, expect, it } from '@jest/globals';

import { waitForCanonicalMessageSyncpoint } from './message_syncpoint.js';

describe('waitForCanonicalMessageSyncpoint', () => {
  /** An archiver whose syncpoint takes the given values on successive reads. */
  const archiverReporting = (points: ({ l1BlockNumber: bigint; l1BlockHash: Buffer32 } | undefined)[]) => {
    let call = 0;
    return {
      getSyncedMessageL1Block: () => Promise.resolve(points[Math.min(call++, points.length - 1)]),
    };
  };

  /** A canonical chain of block hashes by height, shortest-suffix-first: heights past the end do not exist. */
  const chain = (hashesByHeight: Record<string, string>) => ({
    getCanonicalBlockHash: (l1BlockNumber: bigint) => Promise.resolve(hashesByHeight[l1BlockNumber.toString()]),
  });

  const hash = (seed: number) => Buffer32.fromNumber(seed);

  it('rejects a syncpoint left over from the abandoned chain at the same height', async () => {
    const stale = { l1BlockNumber: 100n, l1BlockHash: hash(1) };
    const reconciled = { l1BlockNumber: 100n, l1BlockHash: hash(2) };
    const archiver = archiverReporting([stale, stale, reconciled]);

    const result = await waitForCanonicalMessageSyncpoint(archiver, chain({ '100': hash(2).toString() }), {
      atLeastL1BlockNumber: 100n,
      what: 'canonical syncpoint',
      timeoutSeconds: 5,
      interval: 0.01,
    });

    expect(result).toEqual(reconciled);
  });

  // The pre-reorg syncpoint normally sits above the block a replacement starts at, so a height-only test passes
  // before any reconciliation has happened. It has to be rejected on its hash.
  it('rejects a higher stale syncpoint rather than accepting it as a descendant', async () => {
    const staleAbove = { l1BlockNumber: 105n, l1BlockHash: hash(1) };
    const reconciled = { l1BlockNumber: 106n, l1BlockHash: hash(3) };
    const archiver = archiverReporting([staleAbove, staleAbove, reconciled]);

    const result = await waitForCanonicalMessageSyncpoint(
      archiver,
      // Height 105 exists on the canonical chain but holds a different block than the stale syncpoint names.
      chain({ '105': hash(9).toString(), '106': hash(3).toString() }),
      { atLeastL1BlockNumber: 100n, what: 'canonical syncpoint', timeoutSeconds: 5, interval: 0.01 },
    );

    expect(result).toEqual(reconciled);
  });

  it('accepts a canonical descendant of the required height', async () => {
    const descendant = { l1BlockNumber: 104n, l1BlockHash: hash(4) };
    const archiver = archiverReporting([descendant]);

    const result = await waitForCanonicalMessageSyncpoint(archiver, chain({ '104': hash(4).toString() }), {
      atLeastL1BlockNumber: 100n,
      what: 'canonical syncpoint',
      timeoutSeconds: 5,
      interval: 0.01,
    });

    expect(result).toEqual(descendant);
  });

  it('waits out a syncpoint that has not reached the required height', async () => {
    const behind = { l1BlockNumber: 99n, l1BlockHash: hash(5) };
    const caughtUp = { l1BlockNumber: 100n, l1BlockHash: hash(6) };
    const archiver = archiverReporting([behind, behind, caughtUp]);

    const result = await waitForCanonicalMessageSyncpoint(
      archiver,
      chain({ '99': hash(5).toString(), '100': hash(6).toString() }),
      { atLeastL1BlockNumber: 100n, what: 'canonical syncpoint', timeoutSeconds: 5, interval: 0.01 },
    );

    expect(result).toEqual(caughtUp);
  });

  // A syncpoint naming a height the canonical chain does not reach is on an abandoned suffix, which is the state a
  // reorg deeper than its replacement leaves behind.
  it('waits out a syncpoint naming a height past the canonical tip', async () => {
    const pastTip = { l1BlockNumber: 110n, l1BlockHash: hash(7) };
    const reconciled = { l1BlockNumber: 100n, l1BlockHash: hash(8) };
    const archiver = archiverReporting([pastTip, pastTip, reconciled]);

    const result = await waitForCanonicalMessageSyncpoint(archiver, chain({ '100': hash(8).toString() }), {
      atLeastL1BlockNumber: 100n,
      what: 'canonical syncpoint',
      timeoutSeconds: 5,
      interval: 0.01,
    });

    expect(result).toEqual(reconciled);
  });

  it('never resolves on an absent syncpoint', async () => {
    const archiver = archiverReporting([undefined]);

    await expect(
      waitForCanonicalMessageSyncpoint(archiver, chain({}), {
        atLeastL1BlockNumber: 100n,
        what: 'canonical syncpoint',
        timeoutSeconds: 0.2,
        interval: 0.01,
      }),
    ).rejects.toThrow();
  });
});
