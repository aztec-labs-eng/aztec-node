import { toArray } from '@aztec-labs/foundation/iterable';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

import { openStoreAt, openTmpStore } from './factory.js';
import type { ReadTransaction } from './read_transaction.js';
import { AztecLMDBStoreV2 } from './store.js';

const testMaxReaders = 4;

describe('AztecLMDBStoreV2', () => {
  let store: AztecLMDBStoreV2;

  beforeEach(async () => {
    store = await openTmpStore('test', true, 10 * 1024 * 1024, testMaxReaders, undefined);
  });

  afterEach(async () => {
    await store.delete();
  });

  it('returns undefined for unset keys', async () => {
    const tx = store.getReadTx();
    try {
      expect(await tx.get(Buffer.from('foo'))).toBeUndefined();
      expect(await tx.getIndex(Buffer.from('foo'))).toEqual([]);
    } finally {
      tx.close();
    }
  });

  it('reads and writes in separate txs', async () => {
    const writeChecks = promiseWithResolvers<void>();
    const delay = promiseWithResolvers<void>();
    const getValues = async (tx?: ReadTransaction) => {
      let shouldClose = false;
      if (!tx) {
        tx = store.getCurrentWriteTx();
        if (!tx) {
          shouldClose = true;
          tx = store.getReadTx();
        }
      }

      try {
        const data = await tx.get(Buffer.from('foo'));
        const index = await tx.getIndex(Buffer.from('foo'));

        return {
          data,
          index,
        };
      } finally {
        if (shouldClose) {
          tx.close();
        }
      }
    };

    // before doing any writes, we should have an empty db
    expect(await getValues()).toEqual({
      data: undefined,
      index: [],
    });

    // start a write and run some checks but prevent the write tx from finishing immediately in order to run concurrent reads
    const writeCommitted = store.transactionAsync(async writeTx => {
      await writeTx.set(Buffer.from('foo'), Buffer.from('bar'));
      await writeTx.setIndex(Buffer.from('foo'), Buffer.from('bar'), Buffer.from('baz'));

      // the write tx should make the writes visible immediately
      expect(await getValues(writeTx)).toEqual({
        data: Buffer.from('bar'),
        index: [Buffer.from('bar'), Buffer.from('baz')],
      });

      // even without access to the tx, the writes should still be visible in this context
      expect(await getValues()).toEqual({
        data: Buffer.from('bar'),
        index: [Buffer.from('bar'), Buffer.from('baz')],
      });

      writeChecks.resolve();

      // prevent this write from ending
      await delay.promise;
    });

    // we don't know a write is happening, so we should get an empty result back
    expect(await getValues()).toEqual({
      data: undefined,
      index: [],
    });

    // wait for the batch checks to complete
    await writeChecks.promise;

    // to batch is ready but uncommmitted, we should still see empty data
    expect(await getValues()).toEqual({
      data: undefined,
      index: [],
    });

    delay.resolve();
    await writeCommitted;

    // now we should see the db update
    expect(await getValues()).toEqual({
      data: Buffer.from('bar'),
      index: [Buffer.from('bar'), Buffer.from('baz')],
    });
  });

  it('gives reads inside a transaction a consistent snapshot while a concurrent write is queued', async () => {
    const map = store.openMap<string, string>('snapshot');
    await map.set('k', 'v1');

    const started = promiseWithResolvers<void>();
    const release = promiseWithResolvers<void>();

    const snapshotReads = store.transactionAsync(async () => {
      const first = await map.getAsync('k');
      started.resolve();
      await release.promise;
      const second = await map.getAsync('k');
      return [first, second];
    });

    await started.promise;
    // Queue a competing write for the same key. The single writer serializes it behind the in-flight
    // transaction, so it cannot commit until that transaction finishes.
    const concurrentWrite = map.set('k', 'v2');
    release.resolve();

    const [first, second] = await snapshotReads;
    await concurrentWrite;

    // Both reads inside the transaction observe the pre-write value; the queued write only lands after.
    expect(first).toBe('v1');
    expect(second).toBe('v1');
    expect(await map.getAsync('k')).toBe('v2');
  });

  describe('readOnlyTransaction', () => {
    it('keeps every read on the same committed state while a concurrent write is issued', async () => {
      const map = store.openMap<string, string>('ro-snapshot');
      await map.set('k', 'v1');

      const opened = promiseWithResolvers<void>();
      const writeIssued = promiseWithResolvers<void>();

      const snapshotReads = store.readOnlyTransaction(async () => {
        const first = await map.getAsync('k');
        opened.resolve();
        await writeIssued.promise;
        // Give the write a chance to commit; whether it can do so while this callback runs is up to the backend.
        await sleep(20);
        return [first, await map.getAsync('k'), await map.hasAsync('k')];
      });

      await opened.promise;
      const write = map.set('k', 'v2');
      writeIssued.resolve();

      await expect(snapshotReads).resolves.toEqual(['v1', 'v1', true]);
      await write;
      await expect(map.getAsync('k')).resolves.toBe('v2');
    });

    it('does not observe rows written concurrently while iterating', async () => {
      const map = store.openMap<string, string>('ro-iteration');
      await store.transactionAsync(async () => {
        await map.set('a', '1');
        await map.set('b', '2');
      });

      const opened = promiseWithResolvers<void>();
      const writeIssued = promiseWithResolvers<void>();

      const snapshotEntries = store.readOnlyTransaction(async () => {
        await map.getAsync('a');
        opened.resolve();
        await writeIssued.promise;
        await sleep(20);
        return { entries: await toArray(map.entriesAsync()), size: await map.sizeAsync() };
      });

      await opened.promise;
      const write = map.set('c', '3');
      writeIssued.resolve();

      await expect(snapshotEntries).resolves.toEqual({
        entries: [
          ['a', '1'],
          ['b', '2'],
        ],
        size: 2,
      });
      await write;
      await expect(map.sizeAsync()).resolves.toBe(3);
    });

    it('reuses the enclosing read-only transaction when nested', async () => {
      const map = store.openMap<string, string>('ro-nested');
      await map.set('k', 'v');

      const result = await store.readOnlyTransaction(outerTx =>
        store.readOnlyTransaction(async innerTx => ({ sameTx: innerTx === outerTx, value: await map.getAsync('k') })),
      );

      expect(result).toEqual({ sameTx: true, value: 'v' });
    });

    it('sees uncommitted writes when nested inside a write transaction', async () => {
      const map = store.openMap<string, string>('ro-nested-write');
      await map.set('k', 'v1');

      const result = await store.transactionAsync(async writeTx => {
        await map.set('k', 'v2');
        return store.readOnlyTransaction(async tx => ({ sameTx: tx === writeTx, value: await map.getAsync('k') }));
      });

      expect(result).toEqual({ sameTx: true, value: 'v2' });
    });

    it('rejects once the store is closed', async () => {
      await store.close();
      await expect(store.readOnlyTransaction(() => Promise.resolve(1))).rejects.toThrow('Store is closed');
    });
  });

  it('should serialize writes correctly', async () => {
    const key = Buffer.from('foo');
    const inc = () =>
      store.transactionAsync(async tx => {
        const buf = Buffer.from((await store.getReadTx().get(key)) ?? Buffer.alloc(4));
        buf.writeUint32BE(buf.readUInt32BE() + 1);
        await tx.set(key, buf);
      });

    const promises: Promise<void>[] = [];
    const rounds = 100;
    for (let i = 0; i < rounds; i++) {
      promises.push(inc());
    }

    await Promise.all(promises);
    expect(Buffer.from((await store.getReadTx().get(key))!).readUint32BE()).toBe(rounds);
  });

  it('guards against too many cursors being opened at the same time', async () => {
    await store.transactionAsync(async tx => {
      for (let i = 0; i < 100; i++) {
        await tx.set(Buffer.from(String(i)), Buffer.from(String(i)));
      }
    });

    const readTx = store.getReadTx();
    const cursors: AsyncIterator<[Uint8Array, Uint8Array]>[] = [];

    // fill up with cursors
    for (let i = 0; i < testMaxReaders; i++) {
      cursors.push(readTx.iterate(Buffer.from('1'))[Symbol.asyncIterator]());
    }

    // the first few iterators should be fine
    await expect(Promise.all(cursors.slice(0, -1).map(it => it.next()))).resolves.toEqual([
      { value: [Buffer.from('1'), Buffer.from('1')], done: false },
      { value: [Buffer.from('1'), Buffer.from('1')], done: false },
      { value: [Buffer.from('1'), Buffer.from('1')], done: false },
    ]);

    // this promise should be blocked until we release a cursor
    const fn = vi.fn();
    void cursors.at(-1)!.next().then(fn, fn);

    expect(fn).not.toHaveBeenCalled();
    await sleep(100);
    expect(fn).not.toHaveBeenCalled();

    // but we can still do regular reads
    await expect(readTx.get(Buffer.from('99'))).resolves.toEqual(Buffer.from('99'));

    // early-return one of the cursors
    await cursors[0].return!();

    // this should have unblocked the last cursor from progressing
    await sleep(10);
    expect(fn).toHaveBeenCalledWith({ value: [Buffer.from('1'), Buffer.from('1')], done: false });

    for (let i = 1; i < testMaxReaders; i++) {
      await cursors[i].return!();
    }

    readTx.close();
  });

  it('copies and restores data', async () => {
    const key = Buffer.from('foo');
    const value = Buffer.from('bar');
    await store.transactionAsync(tx => tx.set(key, value));
    expect(Buffer.from((await store.getReadTx().get(key))!).toString()).toBe('bar');

    const backupDir = await mkdtemp(join(tmpdir(), 'lmdb-store-test-backup'));
    await store.backupTo(backupDir, true);

    const store2 = await openStoreAt(backupDir);
    expect(Buffer.from((await store2.getReadTx().get(key))!).toString()).toBe('bar');
    await store2.close();
    await store2.delete();
  });

  describe('Map size validation', () => {
    it('rejects zero map size', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'lmdb-map-size-test-'));
      try {
        await AztecLMDBStoreV2.new(dataDir, 0);
        throw new Error('Expected an error for zero map size');
      } catch (e: any) {
        expect(e.message).toContain('Map size must be a positive number');
      }
    });

    it('rejects negative map size', async () => {
      const dataDir = await mkdtemp(join(tmpdir(), 'lmdb-map-size-test-'));
      try {
        await AztecLMDBStoreV2.new(dataDir, -1);
        throw new Error('Expected an error for negative map size');
      } catch (e: any) {
        expect(e.message).toContain('Map size must be a positive number');
      }
    });
  });
});
