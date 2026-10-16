import { type Logger, type LoggerBindings, createLogger } from '@aztec-labs/foundation/log';
import { Semaphore, SerialQueue } from '@aztec-labs/foundation/queue';
import { sleep } from '@aztec-labs/foundation/sleep';
import { MsgpackChannel, NativeLMDBStore } from '@aztec-labs/native';
import { AsyncLocalStorage } from 'async_hooks';
import { mkdir, rm } from 'fs/promises';

import type { AztecAsyncArray } from '../interfaces/array.js';
import type { Key, StoreSize, Value } from '../interfaces/common.js';
import type { AztecAsyncCounter } from '../interfaces/counter.js';
import type { AztecAsyncMap } from '../interfaces/map.js';
import type { AztecAsyncMultiMap } from '../interfaces/multi_map.js';
import type { AztecAsyncSet } from '../interfaces/set.js';
import type { AztecAsyncSingleton } from '../interfaces/singleton.js';
import type { AztecAsyncKVStore } from '../interfaces/store.js';
import { LMDBArray } from './array.js';
import { LMDBMap } from './map.js';
import {
  Database,
  type LMDBMessageChannel,
  LMDBMessageType,
  type LMDBRequestBody,
  type LMDBResponseBody,
} from './message.js';
import { LMDBMultiMap } from './multi_map.js';
import { ReadTransaction } from './read_transaction.js';
import { LMDBSet } from './set.js';
import { LMDBSingleValue } from './singleton.js';
import { WriteTransaction } from './write_transaction.js';

export { execInReadTx, execInWriteTx } from './tx-helpers.js';

/** Attempts at opening a native read transaction before a read-only transaction falls back to the writer queue. */
const START_READ_TX_ATTEMPTS = 8;
/** Longest wait between two of those attempts. */
const START_READ_TX_MAX_BACKOFF_MS = 64;

export class AztecLMDBStoreV2 implements AztecAsyncKVStore, LMDBMessageChannel {
  private open = false;
  private channel: MsgpackChannel<LMDBMessageType, LMDBRequestBody, LMDBResponseBody>;
  private writerCtx = new AsyncLocalStorage<WriteTransaction>();
  private readerCtx = new AsyncLocalStorage<ReadTransaction>();
  private writerQueue = new SerialQueue();
  /**
   * Reader slots handed out to read transactions and to cursors opened outside one. One slot is kept back for point
   * reads, and the native store refuses a read transaction that would take it.
   */
  private availableReaders: Semaphore;
  /** Open cursors that each hold a slot from {@link availableReaders}; cursors inside a read transaction hold none. */
  private readerCursors = new Set<number>();

  private constructor(
    private dataDir: string,
    mapSize: number,
    maxReaders: number,
    private log: Logger,
    private cleanup?: () => Promise<void>,
    ephemeral: boolean = false,
  ) {
    // One reader is always kept back for point reads and the rest are handed out to cursors and read transactions, so
    // fewer than two would leave no slot for them and every iteration would wait forever.
    if (!Number.isInteger(maxReaders) || maxReaders < 2) {
      throw new Error(`maxReaders must be an integer of at least 2, got ${maxReaders}`);
    }
    this.log.info(`Starting data store with maxReaders ${maxReaders}`);
    this.channel = new MsgpackChannel(new NativeLMDBStore(dataDir, mapSize, maxReaders, ephemeral));
    this.availableReaders = new Semaphore(maxReaders - 1);
  }

  public get dataDirectory(): string {
    return this.dataDir;
  }

  private async start() {
    this.writerQueue.start();

    await this.channel.sendMessage(LMDBMessageType.OPEN_DATABASE, {
      db: Database.DATA,
      uniqueKeys: true,
    });

    await this.channel.sendMessage(LMDBMessageType.OPEN_DATABASE, {
      db: Database.INDEX,
      uniqueKeys: false,
    });

    this.open = true;
  }

  public static async new(
    dataDir: string,
    dbMapSizeKb: number = 10 * 1024 * 1024,
    maxReaders: number = 16,
    cleanup?: () => Promise<void>,
    bindings?: LoggerBindings,
    ephemeral: boolean = false,
  ) {
    const log = createLogger('kv-store:lmdb-v2', bindings);
    const db = new AztecLMDBStoreV2(dataDir, dbMapSizeKb, maxReaders, log, cleanup, ephemeral);
    await db.start();
    return db;
  }

  public async backupTo(dstPath: string, compact = true) {
    await mkdir(dstPath, { recursive: true });
    await this.channel.sendMessage(LMDBMessageType.COPY_STORE, { dstPath, compact });
  }

  public getReadTx(): ReadTransaction {
    if (!this.open) {
      throw new Error('Store is closed');
    }
    return new ReadTransaction(this);
  }

  public getCurrentWriteTx(): WriteTransaction | undefined {
    if (!this.open) {
      throw new Error('Store is closed');
    }
    const currentWrite = this.writerCtx.getStore();
    return currentWrite;
  }

  /**
   * Returns the transaction that reads issued from the current async context must use: the enclosing write transaction,
   * or else the enclosing {@link readOnlyTransaction}. Callers must not close it.
   */
  public getCurrentTx(): ReadTransaction | undefined {
    return this.getCurrentWriteTx() ?? this.readerCtx.getStore();
  }

  openMap<K extends Key, V extends Value>(name: string): AztecAsyncMap<K, V> {
    return new LMDBMap(this, name);
  }

  openMultiMap<K extends Key, V extends Value>(name: string): AztecAsyncMultiMap<K, V> {
    return new LMDBMultiMap(this, name);
  }

  openSingleton<T extends Value>(name: string): AztecAsyncSingleton<T> {
    return new LMDBSingleValue(this, name);
  }

  openArray<T extends Value>(name: string): AztecAsyncArray<T> {
    return new LMDBArray(this, name);
  }

  openSet<K extends Key>(name: string): AztecAsyncSet<K> {
    return new LMDBSet(this, name);
  }

  openCounter<K extends Key>(_name: string): AztecAsyncCounter<K> {
    throw new Error('Not implemented');
  }

  async transactionAsync<T extends Exclude<any, Promise<any>>>(
    callback: (tx: WriteTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.open) {
      throw new Error('Store is closed');
    }

    // checked first: a read-only transaction that fell back to the writer queue runs inside a write transaction
    if (this.readerCtx.getStore()) {
      throw new Error('Cannot start a write transaction inside a read-only transaction');
    }

    // transactionAsync might be called recursively
    // send any writes to the parent tx, but don't close it
    // if the callback throws then the parent tx will rollback automatically
    const currentTx = this.getCurrentWriteTx();
    if (currentTx) {
      return await callback(currentTx);
    }

    return this.writerQueue.put(async () => {
      const tx = new WriteTransaction(this);
      try {
        const res = await this.writerCtx.run(tx, callback, tx);
        await tx.commit();
        return res;
      } catch (err) {
        this.log.error(`Failed to commit transaction`, err);
        throw err;
      } finally {
        tx.close();
      }
    });
  }

  /**
   * Runs the callback against a snapshot of the store: every read inside it, whether through the supplied transaction
   * or through a container such as a map, observes the state committed when the snapshot was opened. The snapshot is a
   * native read transaction, so the callback neither waits for queued writes nor holds up writes issued while it runs.
   * Starting a write transaction inside the callback throws.
   *
   * The snapshot holds one reader slot until the callback settles, and reads inside it, including cursors, take no
   * further slot. Cursors still open when the callback settles are closed with the snapshot. A nested call reuses the
   * enclosing snapshot, and a call inside a write transaction reuses that transaction, uncommitted writes included.
   *
   * If the native store keeps refusing to open a snapshot because every reader is busy, the callback runs inside a
   * {@link transactionAsync} instead: still consistent and still unable to write, but queued with the writes.
   */
  async readOnlyTransaction<T extends Exclude<any, Promise<any>>>(
    callback: (tx: ReadTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.open) {
      throw new Error('Store is closed');
    }

    const currentTx = this.getCurrentTx();
    if (currentTx) {
      return await callback(currentTx);
    }

    await this.acquireReader();
    try {
      const txId = await this.startReadTx();
      if (txId !== undefined) {
        const tx = new ReadTransaction(this, txId);
        try {
          return await this.readerCtx.run(tx, callback, tx);
        } finally {
          tx.close();
          await this.closeReadTx(tx, txId);
        }
      }
    } finally {
      this.availableReaders.release();
    }

    this.log.warn(
      `No reader slot to open a read-only snapshot after ${START_READ_TX_ATTEMPTS} attempts, running it in the writer queue`,
    );
    return this.transactionAsync(tx => this.readerCtx.run(tx, callback, tx));
  }

  /** Takes a slot from {@link availableReaders}, failing if the store was closed while waiting for it. */
  private async acquireReader() {
    await this.availableReaders.acquire();
    if (!this.open) {
      // pass the slot on, so every other waiter wakes up and fails too
      this.availableReaders.release();
      throw new Error('Store is closed');
    }
  }

  /**
   * Opens a native read transaction and returns its id, or undefined if the store had no reader to spare. The native
   * store refuses one, rather than waiting, when it would take the reader slot kept for point reads; holding an
   * {@link availableReaders} slot rules that out except while point reads are in flight, so a refusal is retried with
   * a short backoff.
   */
  private async startReadTx(): Promise<number | undefined> {
    for (let attempt = 1; attempt <= START_READ_TX_ATTEMPTS; attempt++) {
      try {
        return (await this.sendMessage(LMDBMessageType.START_READ_TX, undefined)).txId;
      } catch (err) {
        if (!String(err).includes('No reader slot available')) {
          throw err;
        }
        if (attempt < START_READ_TX_ATTEMPTS) {
          await sleep(Math.min(2 ** attempt, START_READ_TX_MAX_BACKOFF_MS));
        }
      }
    }
    return undefined;
  }

  private async closeReadTx(tx: ReadTransaction, txId: number) {
    // Closing the store releases every native read transaction and cursor, so there is nothing left to close.
    if (!this.open) {
      return;
    }
    try {
      // a cursor keeps its native read transaction alive, so the snapshot only frees its reader once they are closed
      await tx.closeOpenCursors();
    } catch (err) {
      this.log.warn(`Failed to close cursors of read transaction ${txId}`, err);
    }
    try {
      await this.sendMessage(LMDBMessageType.CLOSE_READ_TX, { txId });
    } catch (err) {
      this.log.warn(`Failed to close read transaction ${txId}`, err);
    }
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  async delete(): Promise<void> {
    await this.close();
    await rm(this.dataDir, { recursive: true, force: true, maxRetries: 3 });
    this.log.verbose(`Deleted database files at ${this.dataDir}`);
    await this.cleanup?.();
  }

  async close() {
    if (!this.open) {
      // already closed
      return;
    }
    this.open = false;
    // wake the callers waiting for a reader slot, which fail now that the store is closed
    this.availableReaders.release();
    await this.writerQueue.cancel();
    await this.channel.sendMessage(LMDBMessageType.CLOSE, undefined);
  }

  public async sendMessage<T extends LMDBMessageType>(
    msgType: T,
    body: LMDBRequestBody[T],
  ): Promise<LMDBResponseBody[T]> {
    if (!this.open) {
      throw new Error('Store is closed');
    }

    // A cursor opened inside a read transaction reads through that transaction's reader slot; any other cursor opens a
    // native read transaction of its own for as long as it stays open.
    const takesReader =
      msgType === LMDBMessageType.START_CURSOR &&
      (body as LMDBRequestBody[LMDBMessageType.START_CURSOR]).txId === undefined;
    if (takesReader) {
      await this.acquireReader();
    }

    let response: LMDBResponseBody[T] | undefined = undefined;
    try {
      ({ response } = await this.channel.sendMessage(msgType, body));
      return response;
    } finally {
      if (takesReader) {
        // it's possible for a START_CURSOR command to not return a cursor (e.g. db is empty)
        const cursor = (response as LMDBResponseBody[LMDBMessageType.START_CURSOR] | undefined)?.cursor;
        if (typeof cursor === 'number') {
          this.readerCursors.add(cursor);
        } else {
          this.availableReaders.release();
        }
      } else if (
        msgType === LMDBMessageType.CLOSE_CURSOR &&
        this.readerCursors.delete((body as LMDBRequestBody[LMDBMessageType.CLOSE_CURSOR]).cursor)
      ) {
        this.availableReaders.release();
      }
    }
  }

  public async estimateSize(): Promise<StoreSize> {
    const resp = await this.sendMessage(LMDBMessageType.STATS, undefined);
    return {
      mappingSize: Number(resp.dbMapSizeBytes),
      physicalFileSize: Number(resp.dbPhysicalFileSizeBytes),
      actualSize: resp.stats.reduce((s, db) => Number(db.totalUsedSize) + s, 0),
      numItems: resp.stats.reduce((s, db) => Number(db.numDataItems) + s, 0),
    };
  }
}
