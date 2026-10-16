import { toArray } from '@aztec-labs/foundation/iterable';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

import { openStoreAt, openTmpStore } from './factory.js';
import { LMDBMessageType } from './message.js';
import type { ReadTransaction } from './read_transaction.js';
import { AztecLMDBStoreV2 } from './store.js';
import { WriteTransaction } from './write_transaction.js';

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
      const writeCommitted = promiseWithResolvers<void>();

      const snapshotReads = store.readOnlyTransaction(async () => {
        const first = await map.getAsync('k');
        opened.resolve();
        await writeCommitted.promise;
        return [first, await map.getAsync('k'), await map.hasAsync('k')];
      });

      await opened.promise;
      await map.set('k', 'v2');
      writeCommitted.resolve();

      await expect(snapshotReads).resolves.toEqual(['v1', 'v1', true]);
      await expect(map.getAsync('k')).resolves.toBe('v2');
    });

    it('does not observe rows written concurrently while iterating', async () => {
      const map = store.openMap<string, string>('ro-iteration');
      await store.transactionAsync(async () => {
        await map.set('a', '1');
        await map.set('b', '2');
      });

      const opened = promiseWithResolvers<void>();
      const writeCommitted = promiseWithResolvers<void>();

      const snapshotEntries = store.readOnlyTransaction(async () => {
        await map.getAsync('a');
        opened.resolve();
        await writeCommitted.promise;
        return { entries: await toArray(map.entriesAsync()), size: await map.sizeAsync() };
      });

      await opened.promise;
      await map.set('c', '3');
      writeCommitted.resolve();

      await expect(snapshotEntries).resolves.toEqual({
        entries: [
          ['a', '1'],
          ['b', '2'],
        ],
        size: 2,
      });
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

    it('does not wait for a write transaction that is still running', async () => {
      const map = store.openMap<string, string>('ro-skips-writer-queue');
      await map.set('k', 'v1');

      const writeStaged = promiseWithResolvers<void>();
      const finishWrite = promiseWithResolvers<void>();
      const write = store.transactionAsync(async () => {
        await map.set('k', 'v2');
        writeStaged.resolve();
        await finishWrite.promise;
      });
      await writeStaged.promise;

      // The write holds the writer queue until it is told to finish, so this only settles if the snapshot skips it.
      await expect(store.readOnlyTransaction(() => map.getAsync('k'))).resolves.toBe('v1');

      finishWrite.resolve();
      await write;
      await expect(map.getAsync('k')).resolves.toBe('v2');
    });

    it('lets writes commit while it is open', async () => {
      const map = store.openMap<string, string>('ro-does-not-block-writes');
      await map.set('k', 'v1');

      const opened = promiseWithResolvers<void>();
      const finishRead = promiseWithResolvers<void>();
      const read = store.readOnlyTransaction(async () => {
        opened.resolve();
        await finishRead.promise;
        return map.getAsync('k');
      });
      await opened.promise;

      await map.set('k', 'v2');
      await expect(map.getAsync('k')).resolves.toBe('v2');

      finishRead.resolve();
      await expect(read).resolves.toBe('v1');
    });

    it('rejects a write started inside it', async () => {
      const map = store.openMap<string, string>('ro-rejects-writes');
      await map.set('k', 'v1');

      await expect(store.readOnlyTransaction(() => map.set('k', 'v2'))).rejects.toThrow(
        'Cannot start a write transaction inside a read-only transaction',
      );
      await expect(map.getAsync('k')).resolves.toBe('v1');
    });

    it('falls back to the writer queue when the native store has no reader to spare', async () => {
      const map = store.openMap<string, string>('ro-fallback');
      await map.set('k', 'v');

      const sendMessage = store.sendMessage.bind(store);
      vi.spyOn(store, 'sendMessage').mockImplementation((msgType, body) =>
        msgType === LMDBMessageType.START_READ_TX
          ? Promise.reject(new Error('No reader slot available to start a read transaction'))
          : sendMessage(msgType, body),
      );

      await expect(
        store.readOnlyTransaction(async tx => ({
          writeTx: tx instanceof WriteTransaction,
          value: await map.getAsync('k'),
        })),
      ).resolves.toEqual({ writeTx: true, value: 'v' });
      await expect(store.readOnlyTransaction(() => map.set('k', 'v2'))).rejects.toThrow(
        'Cannot start a write transaction inside a read-only transaction',
      );
      await expect(map.getAsync('k')).resolves.toBe('v');
    });

    describe('with a single reader slot', () => {
      let smallStore: AztecLMDBStoreV2;

      beforeEach(async () => {
        smallStore = await openTmpStore('test-one-reader-slot', true, 10 * 1024 * 1024, 2, undefined);
      });

      afterEach(async () => {
        await smallStore.delete();
      });

      it('closes cursors left open by its callback and frees the slot for the next snapshot', async () => {
        const map = smallStore.openMap<number, number>('ro-abandoned-cursor');
        await smallStore.transactionAsync(async () => {
          for (let i = 0; i < 50; i++) {
            await map.set(i, i);
          }
        });

        const abandoned = await smallStore.readOnlyTransaction(async () => {
          const iterator = map.entriesAsync()[Symbol.asyncIterator]();
          await iterator.next();
          return iterator;
        });

        // The next snapshot must be a real one: if the abandoned cursor still held the only reader, it would fall back
        // to the writer queue and wait behind this unfinished write.
        const writeStaged = promiseWithResolvers<void>();
        const finishWrite = promiseWithResolvers<void>();
        const write = smallStore.transactionAsync(async () => {
          await map.set(0, -1);
          writeStaged.resolve();
          await finishWrite.promise;
        });
        await writeStaged.promise;
        await expect(smallStore.readOnlyTransaction(() => map.getAsync(0))).resolves.toBe(0);
        finishWrite.resolve();
        await write;

        await expect(toArray({ [Symbol.asyncIterator]: () => abandoned })).rejects.toThrow(
          'Cursor was closed with its transaction',
        );
      });

      it('closes a cursor whose start was still in flight when its callback settled', async () => {
        const map = smallStore.openMap<number, number>('ro-in-flight-cursor');
        await smallStore.transactionAsync(async () => {
          for (let i = 0; i < 50; i++) {
            await map.set(i, i);
          }
        });

        // Hold back the response to the snapshot's START_CURSOR until its callback has returned.
        const cursorStarted = promiseWithResolvers<void>();
        const deliverCursor = promiseWithResolvers<void>();
        const sendMessage = smallStore.sendMessage.bind(smallStore);
        vi.spyOn(smallStore, 'sendMessage').mockImplementation(async (msgType, body) => {
          const response = await sendMessage(msgType, body);
          if (msgType === LMDBMessageType.START_CURSOR && 'txId' in (body as object)) {
            cursorStarted.resolve();
            await deliverCursor.promise;
          }
          return response;
        });

        let firstEntry: Promise<unknown> | undefined;
        const snapshot = smallStore.readOnlyTransaction(async () => {
          firstEntry = map.entriesAsync()[Symbol.asyncIterator]().next();
          await cursorStarted.promise;
        });
        await cursorStarted.promise;
        await sleep(10);
        deliverCursor.resolve();
        await snapshot;
        await firstEntry;
        vi.restoreAllMocks();

        // As above, the next snapshot must be a real one rather than a fallback queued behind this write.
        const writeStaged = promiseWithResolvers<void>();
        const finishWrite = promiseWithResolvers<void>();
        const write = smallStore.transactionAsync(async () => {
          await map.set(0, -1);
          writeStaged.resolve();
          await finishWrite.promise;
        });
        await writeStaged.promise;
        await expect(smallStore.readOnlyTransaction(() => map.getAsync(0))).resolves.toBe(0);
        finishWrite.resolve();
        await write;
      });

      it('rejects snapshots still waiting for the slot when the store closes', async () => {
        const opened = promiseWithResolvers<void>();
        const finish = promiseWithResolvers<void>();
        const first = smallStore.readOnlyTransaction(async () => {
          opened.resolve();
          await finish.promise;
        });
        await opened.promise;

        const queued = smallStore.readOnlyTransaction(() => Promise.resolve('never'));
        await smallStore.close();
        await expect(queued).rejects.toThrow('Store is closed');

        finish.resolve();
        await first;
      });

      it('returns the slot when the callback throws', async () => {
        const map = smallStore.openMap<string, string>('ro-slot-on-error');
        await map.set('k', 'v');

        await expect(smallStore.readOnlyTransaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        await expect(smallStore.readOnlyTransaction(() => map.getAsync('k'))).resolves.toBe('v');
      });

      it('runs concurrent multi-page scans inside one snapshot, and queues further snapshots', async () => {
        const map = smallStore.openMap<number, number>('ro-scans');
        const count = 50;
        await smallStore.transactionAsync(async () => {
          for (let i = 0; i < count; i++) {
            await map.set(i, i);
          }
        });
        const expected = Array.from({ length: count }, (_, i) => [i, i]);

        // Cursors inside a snapshot read through its slot; if they waited for slots of their own, the only one would
        // already be held by the snapshot and every scan would wait forever.
        const query = () =>
          smallStore.readOnlyTransaction(() => Promise.all([1, 2, 3, 4].map(() => toArray(map.entriesAsync()))));
        const results = await Promise.all([query(), query(), query()]);

        expect(results).toEqual(Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => expected)));
        // Scans outside a snapshot take the slot back once every snapshot has released it.
        await expect(toArray(map.entriesAsync())).resolves.toEqual(expected);
      });
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

  describe('bounded scans', () => {
    const ENTRIES = 300;
    const key = (i: number) => Buffer.from(String(i).padStart(3, '0'));
    const keysOf = (entries: [Uint8Array, unknown][]) => entries.map(([k]) => Buffer.from(k));
    const keyRange = (from: number, count: number, step = 1) =>
      Array.from({ length: count }, (_, i) => key(from + i * step));

    beforeEach(async () => {
      await store.transactionAsync(async tx => {
        for (let i = 0; i < ENTRIES; i++) {
          await tx.set(key(i), Buffer.from(String(i)));
        }
      });
    });

    /**
     * Starts as many bounded scans as the store has cursor slots and leaves each paused after its first entry. A scan
     * that kept its native cursor open would hold a slot while paused, and any further scan would then never start.
     */
    async function startPausedScans(scan: () => AsyncIterable<[Uint8Array, Uint8Array]>) {
      const paused = Array.from({ length: testMaxReaders - 1 }, () => scan()[Symbol.asyncIterator]());
      await Promise.all(paused.map(it => it.next()));
      return paused;
    }

    async function drain(iterator: AsyncIterator<[Uint8Array, Uint8Array]>) {
      let count = 0;
      while (!(await iterator.next()).done) {
        count++;
      }
      return count;
    }

    it('does not hold a cursor slot while a single-page scan is paused', async () => {
      const readTx = store.getReadTx();
      const paused = await startPausedScans(() => readTx.iterate(key(10), undefined, false, 20));

      // Would wait for a free cursor slot, and so time out, if the paused scans each held one.
      const entries = await toArray(readTx.iterate(key(10), key(90), false, 20));
      expect(keysOf(entries)).toEqual(keyRange(10, 20));

      // the paused scans still deliver the rest of their entries
      await expect(Promise.all(paused.map(drain))).resolves.toEqual(paused.map(() => 19));
      readTx.close();
    });

    it('does not hold a cursor slot while a bounded scan in a write transaction with no pending writes is paused', async () => {
      const entries = await store.transactionAsync(async tx => {
        const paused = await startPausedScans(() => tx.iterate(key(10), undefined, false, 20));
        const scanned = await toArray(tx.iterate(key(10), undefined, false, 20));
        await Promise.all(paused.map(drain));
        return scanned;
      });
      expect(keysOf(entries)).toEqual(keyRange(10, 20));
    });

    it.each([
      ['single page', 128],
      ['paged', 129],
    ])('returns exactly the limit on a %s scan', async (_, limit) => {
      const readTx = store.getReadTx();
      expect(keysOf(await toArray(readTx.iterate(key(0), undefined, false, limit)))).toEqual(keyRange(0, limit));
      expect(keysOf(await toArray(readTx.iterate(key(ENTRIES - 1), undefined, true, limit)))).toEqual(
        keyRange(ENTRIES - 1, limit, -1),
      );
      readTx.close();
    });

    it.each([
      ['single page', 128],
      ['paged', 129],
    ])('stops at the end key on a %s scan', async (_, limit) => {
      const readTx = store.getReadTx();
      expect(keysOf(await toArray(readTx.iterate(key(10), key(60), false, limit)))).toEqual(keyRange(10, 50));
      expect(keysOf(await toArray(readTx.iterate(key(200), key(150), true, limit)))).toEqual(keyRange(200, 50, -1));
      readTx.close();
    });

    it.each([
      ['single page', 128],
      ['paged', 129],
    ])('stops at the end of the data on a %s scan', async (_, limit) => {
      const entries = await toArray(store.getReadTx().iterate(key(ENTRIES - 5), undefined, false, limit));
      expect(keysOf(entries)).toEqual(keyRange(ENTRIES - 5, 5));
    });

    it('merges pending writes into a bounded scan inside a write transaction', async () => {
      const entries = await store.transactionAsync(async tx => {
        await tx.remove(key(11));
        await tx.set(Buffer.from('0105'), Buffer.from('new'));
        return toArray(tx.iterate(key(10), undefined, false, 4));
      });
      expect(entries.map(([k, v]) => [Buffer.from(k).toString(), Buffer.from(v).toString()])).toEqual([
        ['010', '10'],
        ['0105', 'new'],
        ['012', '12'],
        ['013', '13'],
      ]);
    });

    it('merges pending writes into a paged scan inside a write transaction', async () => {
      const entries = await store.transactionAsync(async tx => {
        await tx.remove(key(50));
        return toArray(tx.iterate(key(0), undefined, false, 129));
      });
      expect(keysOf(entries)).toEqual([...keyRange(0, 50), ...keyRange(51, 79)]);
    });
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
