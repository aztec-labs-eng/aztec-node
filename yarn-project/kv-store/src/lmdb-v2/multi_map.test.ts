import { toArray } from '@aztec-labs/foundation/iterable';

import { describeAztecMultiMap } from '../interfaces/multi_map_test_suite.js';
import { openTmpStore } from './factory.js';

describeAztecMultiMap('LMDBMultiMap', () => openTmpStore('test'), true);

describe('LMDBMultiMap numeric keys', () => {
  // A numeric key 0 is a valid key, not an absent range bound or a decode failure. Range iteration
  // (used by the p2p attestation pool's slot-keyed proposal-index cleanup) must include and iterate
  // past it; otherwise cleanup that starts at slot 0 stops at the first key and old indexes leak.

  it('iterates entries past a numeric key 0', async () => {
    const store = await openTmpStore('test-numeric-entries');
    try {
      const map = store.openMultiMap<number, string>('slots');
      await store.transactionAsync(async () => {
        await map.set(0, 'a');
        await map.set(1, 'b');
        await map.set(2, 'c');
      });

      // Without the fix, deserializeKey(0) is falsey and the loop breaks at the first key, yielding [].
      const keys = await store.transactionAsync(async () => (await toArray(map.entriesAsync())).map(([key]) => key));
      expect(keys).toEqual([0, 1, 2]);
    } finally {
      await store.delete();
    }
  });

  it('treats numeric key 0 as a real range bound, not an absent one', async () => {
    const store = await openTmpStore('test-numeric-range');
    try {
      const map = store.openMultiMap<number, string>('slots');
      await store.transactionAsync(async () => {
        await map.set(0, 'a');
        await map.set(1, 'b');
        await map.set(2, 'c');
      });

      await store.transactionAsync(async () => {
        // start is inclusive, so 0 keeps every key. (Forward start:0 cannot by itself distinguish an
        // honored bound from an absent one with non-negative keys - the end:0 case below does that.)
        expect(await toArray(map.keysAsync({ start: 0 }))).toEqual([0, 1, 2]);

        // end is exclusive, so an honored end bound of 0 excludes everything. Without the fix,
        // `range.end ? ...` reads 0 as falsey, drops the bound, and returns all three keys - this
        // assertion is what fails when the zero bound regresses.
        expect(await toArray(map.keysAsync({ end: 0 }))).toEqual([]);

        // A non-zero exclusive end proves 0 still participates as a real key below the bound.
        expect(await toArray(map.keysAsync({ end: 2 }))).toEqual([0, 1]);
      });
    } finally {
      await store.delete();
    }
  });
});
