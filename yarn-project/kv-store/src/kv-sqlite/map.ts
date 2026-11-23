import { Encoder } from '#msgpackr';
import { fromBufferKey, toBufferKey } from '#ordered-binary';
import { Buffer } from 'buffer';

import type { Key, Range, Value } from '../interfaces/common.js';
import type { AztecAsyncMap } from '../interfaces/map.js';
import type { AztecKvSqliteStore } from './store.js';

/** A map over the Kv service: one entry per key, in the container `map:<name>`. */
export class KvSqliteAztecMap<K extends Key, V extends Value> implements AztecAsyncMap<K, V> {
  protected readonly container: string;
  protected readonly encoder = new Encoder();

  constructor(
    protected readonly store: AztecKvSqliteStore,
    mapName: string,
  ) {
    this.container = `map:${mapName}`;
  }

  async getAsync(key: K): Promise<V | undefined> {
    return (await this.getManyAsync([key]))[0];
  }

  /** Reads every key in one command, preserving input order and missing entries. */
  async getManyAsync(keys: K[]): Promise<(V | undefined)[]> {
    if (keys.length === 0) {
      return [];
    }
    const { values } = await this.store.run(kv =>
      kv.get({ container: this.container, keys: keys.map(key => this.encodedKey(key)) }),
    );
    return values.map(({ value }) => (value == null ? undefined : this.decodeValue(value)));
  }

  async hasAsync(key: K): Promise<boolean> {
    return (await this.store.run(kv => kv.has({ container: this.container, key: this.encodedKey(key) }))).has;
  }

  async sizeAsync(): Promise<number> {
    return Number((await this.store.run(kv => kv.count({ container: this.container, key: null }))).count);
  }

  async set(key: K, val: V): Promise<void> {
    await this.store.run(kv =>
      kv.put({ container: this.container, key: this.encodedKey(key), value: this.encoder.pack(val) }),
    );
  }

  async setMany(entries: { key: K; value: V }[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.store.run(kv =>
      kv.putMany({
        container: this.container,
        entries: entries.map(({ key, value }) => ({ key: this.encodedKey(key), value: this.encoder.pack(value) })),
      }),
    );
  }

  swap(_key: K, _fn: (val: V | undefined) => V): Promise<void> {
    throw new Error('Not implemented');
  }

  async setIfNotExists(key: K, val: V): Promise<boolean> {
    return await this.store.transactionAsync(async () => {
      if (await this.hasAsync(key)) {
        return false;
      }
      await this.set(key, val);
      return true;
    });
  }

  async delete(key: K): Promise<void> {
    await this.store.run(kv => kv.delete({ container: this.container, key: this.encodedKey(key) }));
  }

  async *entriesAsync(range: Range<K> = {}): AsyncIterableIterator<[K, V]> {
    // Inclusivity flips with direction to match the IndexedDB backend:
    //   forward: [start, end)     reverse: (start, end]
    // Tests pin the exact inclusivity at boundaries; the Kv service's Range has the same.
    const { entries } = await this.store.run(kv =>
      kv.range({
        container: this.container,
        start: range.start === undefined ? null : this.encodedKey(range.start),
        end: range.end === undefined ? null : this.encodedKey(range.end),
        reverse: !!range.reverse,
        limit: range.limit ?? null,
      }),
    );
    for (const { key, value } of entries) {
      yield [this.decodeKey(key), this.decodeValue(value)];
    }
  }

  async *valuesAsync(range: Range<K> = {}): AsyncIterableIterator<V> {
    for await (const [, value] of this.entriesAsync(range)) {
      yield value;
    }
  }

  async *keysAsync(range: Range<K> = {}): AsyncIterableIterator<K> {
    for await (const [key] of this.entriesAsync(range)) {
      yield key;
    }
  }

  protected decodeValue(val: Uint8Array): V {
    const unpacked = this.encoder.unpack(val);
    // msgpackr returns plain Uint8Array in browsers for packed Buffers. Callers that
    // stored Buffers (walletDB uses Buffer.from(...).toString('utf8') round-trips)
    // rely on Buffer-flavored behavior — re-wrap at the storage boundary, mirroring
    // IndexedDBAztecMap.restoreBuffers.
    if (unpacked instanceof Uint8Array && !Buffer.isBuffer(unpacked)) {
      return Buffer.from(unpacked) as V;
    }
    return unpacked as V;
  }

  protected decodeKey(raw: Uint8Array): K {
    const parsed = fromBufferKey(Buffer.from(raw));
    if (Array.isArray(parsed)) {
      return (parsed.length > 1 ? parsed : parsed[0]) as K;
    }
    return parsed as K;
  }

  protected encodedKey(key: Key): Buffer {
    return toBufferKey(Array.isArray(key) ? key : [key]);
  }
}
