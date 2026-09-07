import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { openTmpStore } from './index.js';

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
});
