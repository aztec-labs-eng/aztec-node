import { toArray } from '@aztec-labs/foundation/iterable';
import { sleep } from '@aztec-labs/foundation/sleep';

import { createStore } from './factory.js';
import type { AztecLMDBStoreV2 } from './store.js';

describe('createStore', () => {
  let store: AztecLMDBStoreV2 | undefined;

  afterEach(async () => {
    await store?.delete();
    store = undefined;
  });

  it('sizes the reader table from dataStoreMaxReaders', async () => {
    // One reader is always kept back for point reads, so two readers leave a single cursor slot.
    store = await createStore('max-readers-test', 1, { dataStoreMapSizeKb: 10 * 1024, dataStoreMaxReaders: 2 });
    await store.transactionAsync(async tx => {
      for (let i = 0; i < 50; i++) {
        await tx.set(Buffer.from(String(i).padStart(2, '0')), Buffer.from(String(i)));
      }
    });

    const readTx = store.getReadTx();
    const holder = readTx.iterate(Buffer.from('00'))[Symbol.asyncIterator]();
    await holder.next();

    const blocked = toArray(readTx.iterate(Buffer.from('00')));
    const outcome = await Promise.race([blocked.then(() => 'completed'), sleep(200).then(() => 'blocked')]);
    expect(outcome).toBe('blocked');

    await holder.return!();
    await expect(blocked).resolves.toHaveLength(50);
    readTx.close();
  });

  it.each([0, 1, 2.5])('rejects dataStoreMaxReaders=%s', async dataStoreMaxReaders => {
    await expect(
      createStore('max-readers-invalid-test', 1, { dataStoreMapSizeKb: 10 * 1024, dataStoreMaxReaders }),
    ).rejects.toThrow('maxReaders must be an integer of at least 2');
  });
});
