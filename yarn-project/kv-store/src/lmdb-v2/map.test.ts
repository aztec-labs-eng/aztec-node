import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { vi } from 'vitest';

import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { openTmpStore } from './index.js';
import { GET_CHUNK_SIZE, LMDBMessageType } from './message.js';

describeAztecMap('LMDBMap', () => openTmpStore('test'), true);

describe('LMDBMap bulk reads', () => {
  it('does not retain uncommitted values after rollback', async () => {
    const store = await openTmpStore('bulk-rollback');
    try {
      const map = store.openMap<string, string>('test');
      await map.set('a', 'old');
      await map.set('b', 'deleted');
      await expect(
        store.transactionAsync(async () => {
          await map.set('a', 'new');
          await map.delete('b');
          expect(await map.getManyAsync(['a', 'b'])).toEqual(['new', undefined]);
          throw new Error('Rollback');
        }),
      ).rejects.toThrow('Rollback');
      expect(await map.getManyAsync(['a', 'b'])).toEqual(['old', 'deleted']);
    } finally {
      await store.delete();
    }
  });

  it('reads every chunk of a multi-request call from the same committed state', async () => {
    const store = await openTmpStore('bulk-snapshot');
    try {
      const map = store.openMap<number, string>('test');
      const keys = Array.from({ length: GET_CHUNK_SIZE + 1 }, (_, i) => i);
      await store.transactionAsync(async () => {
        for (const key of keys) {
          await map.set(key, 'old');
        }
      });

      // Hold the call after its first GET, commit a write to a key of the second chunk, then let it continue.
      const firstChunkRead = promiseWithResolvers<void>();
      const resume = promiseWithResolvers<void>();
      const sendMessage = store.sendMessage.bind(store);
      let gets = 0;
      vi.spyOn(store, 'sendMessage').mockImplementation(async (msgType, body) => {
        const response = await sendMessage(msgType, body);
        if (msgType === LMDBMessageType.GET && ++gets === 1) {
          firstChunkRead.resolve();
          await resume.promise;
        }
        return response;
      });

      const read = map.getManyAsync(keys);
      await firstChunkRead.promise;
      await map.set(GET_CHUNK_SIZE, 'new');
      resume.resolve();

      expect(await read).toEqual(keys.map(() => 'old'));
      expect(await map.getAsync(GET_CHUNK_SIZE)).toBe('new');
    } finally {
      vi.restoreAllMocks();
      await store.delete();
    }
  });
});
