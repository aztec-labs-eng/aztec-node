import { chunk } from '@aztec-labs/foundation/collection';

import {
  CURSOR_PAGE_SIZE,
  Database,
  GET_CHUNK_SIZE,
  type LMDBMessageChannel,
  LMDBMessageType,
  SINGLE_PAGE_LIMIT,
} from './message.js';

export class ReadTransaction {
  protected open = true;

  /** Spread into every read request, so reads run against the native read transaction when there is one. */
  private readonly txField: { txId?: number };
  /** Cursors this transaction opened that are still open. */
  private readonly openCursors = new Set<number>();

  /**
   * @param channel - Channel to the native store.
   * @param txId - Native read transaction, from START_READ_TX, to run every read against. Without one each request
   * reads the latest committed state on its own.
   */
  constructor(
    protected channel: LMDBMessageChannel,
    txId?: number,
  ) {
    this.txField = txId === undefined ? {} : { txId };
  }

  public close(): void {
    if (!this.open) {
      return;
    }
    this.open = false;
  }

  /**
   * Closes every cursor this transaction still has open, such as one left by an iterator that was abandoned before it
   * finished. An iterator whose cursor is closed this way throws on its next page. Errors closing a cursor are thrown.
   */
  public async closeOpenCursors(): Promise<void> {
    const cursors = [...this.openCursors];
    this.openCursors.clear();
    await Promise.all(cursors.map(cursor => this.channel.sendMessage(LMDBMessageType.CLOSE_CURSOR, { cursor })));
  }

  protected assertIsOpen() {
    if (!this.open) {
      throw new Error('Transaction is closed');
    }
  }

  public async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return (await this.getMany([key]))[0];
  }

  /**
   * Reads multiple data keys, returning values in input order. Sends one database request per {@link GET_CHUNK_SIZE}
   * keys.
   */
  public async getMany(keys: Uint8Array[]): Promise<(Uint8Array | undefined)[]> {
    this.assertIsOpen();
    const results: (Uint8Array | undefined)[] = [];
    for (const keysChunk of chunk(keys, GET_CHUNK_SIZE)) {
      const response = await this.channel.sendMessage(LMDBMessageType.GET, {
        keys: keysChunk,
        db: Database.DATA,
        ...this.txField,
      });
      for (let i = 0; i < keysChunk.length; i++) {
        results.push(response.values[i]?.[0] ?? undefined);
      }
    }
    return results;
  }

  public async getIndex(key: Uint8Array): Promise<Uint8Array[]> {
    this.assertIsOpen();
    const response = await this.channel.sendMessage(LMDBMessageType.GET, {
      keys: [key],
      db: Database.INDEX,
      ...this.txField,
    });
    return response.values[0] ?? [];
  }

  public async *iterate(
    startKey: Uint8Array,
    endKey?: Uint8Array,
    reverse = false,
    limit?: number,
  ): AsyncIterable<[Uint8Array, Uint8Array]> {
    yield* this.#iterate(Database.DATA, startKey, endKey, reverse, limit, vals => vals[0]);
  }

  public async *iterateIndex(
    startKey: Uint8Array,
    endKey?: Uint8Array,
    reverse = false,
    limit?: number,
  ): AsyncIterable<[Uint8Array, Uint8Array[]]> {
    yield* this.#iterate(Database.INDEX, startKey, endKey, reverse, limit, vals => vals);
  }

  public countEntries(startKey: Uint8Array, endKey: Uint8Array, reverse: boolean): Promise<number> {
    return this.#countEntries(Database.DATA, startKey, endKey, reverse);
  }

  public countEntriesIndex(startKey: Uint8Array, endKey: Uint8Array, reverse: boolean): Promise<number> {
    return this.#countEntries(Database.INDEX, startKey, endKey, reverse);
  }

  async *#iterate<T>(
    db: string,
    startKey: Uint8Array,
    endKey: Uint8Array | undefined,
    reverse: boolean,
    limit: number | undefined,
    map: (val: Uint8Array[]) => T,
  ): AsyncIterable<[Uint8Array, T]> {
    this.assertIsOpen();

    let cursor: number | undefined;
    try {
      // A bounded scan asks for the whole limit up front: `endKey` is filtered client side, but in-range entries are
      // contiguous from `startKey`, so the first `limit` entries always contain every entry we may return.
      const singlePageLimit = typeof limit === 'number' && limit <= SINGLE_PAGE_LIMIT ? limit : undefined;
      const response = await this.channel.sendMessage(LMDBMessageType.START_CURSOR, {
        key: startKey,
        reverse,
        count: singlePageLimit ?? CURSOR_PAGE_SIZE,
        onePage: singlePageLimit !== undefined,
        db,
        ...this.txField,
      });

      cursor = response.cursor ?? undefined;
      if (typeof cursor === 'number') {
        this.openCursors.add(cursor);
      }
      let entries = response.entries;
      let done = typeof cursor !== 'number';
      let count = 0;
      // emit the first page and any subsequent pages in a while loop
      // NB: end contition is in the middle of the while loop
      while (entries.length > 0) {
        for (const [key, values] of entries) {
          if (typeof limit === 'number' && count >= limit) {
            done = true;
            break;
          }

          if (endKey) {
            const cmp = Buffer.compare(key, endKey);
            if ((!reverse && cmp >= 0) || (reverse && cmp <= 0)) {
              done = true;
              break;
            }
          }

          count++;
          yield [key, map(values)];
        }

        // cursor is null if DB returned everything in the first page
        if (typeof cursor !== 'number' || done) {
          break;
        }
        if (!this.openCursors.has(cursor)) {
          throw new Error('Cursor was closed with its transaction');
        }

        const response = await this.channel.sendMessage(LMDBMessageType.ADVANCE_CURSOR, {
          cursor,
          count: CURSOR_PAGE_SIZE,
        });

        done = response.done;
        entries = response.entries;
      }
    } finally {
      // we might not have anything to close, or the transaction may have closed it already
      if (typeof cursor === 'number' && this.openCursors.delete(cursor)) {
        await this.channel.sendMessage(LMDBMessageType.CLOSE_CURSOR, { cursor });
      }
    }
  }

  async #countEntries(db: string, startKey: Uint8Array, endKey: Uint8Array, reverse: boolean): Promise<number> {
    this.assertIsOpen();

    let cursor: number | undefined;
    try {
      const response = await this.channel.sendMessage(LMDBMessageType.START_CURSOR, {
        key: startKey,
        reverse,
        count: 0,
        onePage: false,
        db,
        ...this.txField,
      });

      cursor = response.cursor ?? undefined;
      if (typeof cursor !== 'number') {
        return 0;
      }
      this.openCursors.add(cursor);

      const advanceResponse = await this.channel.sendMessage(LMDBMessageType.ADVANCE_CURSOR_COUNT, {
        cursor,
        endKey: endKey,
      });

      return advanceResponse.count;
    } finally {
      // we might not have anything to close, or the transaction may have closed it already
      if (typeof cursor === 'number' && this.openCursors.delete(cursor)) {
        await this.channel.sendMessage(LMDBMessageType.CLOSE_CURSOR, { cursor });
      }
    }
  }
}
