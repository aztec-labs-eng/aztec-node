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
    const map = store.openMultiMap<number, string>('slots');
    await map.set(0, 'a');
    await map.set(1, 'b');
    await map.set(2, 'c');

    const keys = (await toArray(map.entriesAsync())).map(([key]) => key);
    expect(keys).toEqual([0, 1, 2]);
  });

  it('honours a numeric key 0 as a range start bound', async () => {
    const store = await openTmpStore('test-numeric-range');
    const map = store.openMultiMap<number, string>('slots');
    await map.set(0, 'a');
    await map.set(1, 'b');
    await map.set(2, 'c');

    const keys = await toArray(map.keysAsync({ start: 0 }));
    expect(keys).toEqual([0, 1, 2]);
  });
});
