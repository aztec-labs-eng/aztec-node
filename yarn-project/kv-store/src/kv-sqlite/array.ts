import { Encoder } from '#msgpackr';
import { toBufferKey } from '#ordered-binary';
import type { Buffer } from 'buffer';

import type { AztecAsyncArray } from '../interfaces/array.js';
import type { Value } from '../interfaces/common.js';
import type { AztecKvSqliteStore } from './store.js';

/**
 * A persistent array over the Kv service: one key (the array's name) in the container `array:<name>`, whose entry
 * indices are the positions, from 1.
 */
export class KvSqliteAztecArray<T extends Value> implements AztecAsyncArray<T> {
  readonly #container: string;
  readonly #key: Buffer;
  readonly #encoder = new Encoder();

  constructor(
    private readonly store: AztecKvSqliteStore,
    name: string,
  ) {
    this.#container = `array:${name}`;
    this.#key = toBufferKey([name]);
  }

  async lengthAsync(): Promise<number> {
    return Number((await this.store.run(kv => kv.count({ container: this.#container, key: this.#key }))).count);
  }

  async push(...vals: T[]): Promise<number> {
    if (vals.length === 0) {
      return this.lengthAsync();
    }
    const { count } = await this.store.run(kv =>
      kv.append({
        container: this.#container,
        key: this.#key,
        values: vals.map(val => this.#encoder.pack(val)),
        unique: false,
      }),
    );
    return Number(count);
  }

  async pop(): Promise<T | undefined> {
    const { value } = await this.store.run(kv => kv.pop({ container: this.#container, key: this.#key }));
    return value == null ? undefined : (this.#encoder.unpack(value) as T);
  }

  async atAsync(index: number): Promise<T | undefined> {
    const position = index < 0 ? (await this.lengthAsync()) + index : index;
    if (position < 0) {
      return undefined;
    }
    const { value } = await this.store.run(kv =>
      kv.getAt({ container: this.#container, key: this.#key, index: position + 1 }),
    );
    return value == null ? undefined : (this.#encoder.unpack(value) as T);
  }

  async setAt(index: number, val: T): Promise<boolean> {
    return await this.store.transactionAsync(async () => {
      const position = index < 0 ? (await this.lengthAsync()) + index : index;
      if (position < 0) {
        return false;
      }
      const { set } = await this.store.run(kv =>
        kv.setAt({
          container: this.#container,
          key: this.#key,
          index: position + 1,
          value: this.#encoder.pack(val),
        }),
      );
      return set;
    });
  }

  async *entriesAsync(): AsyncIterableIterator<[number, T]> {
    const { values } = await this.store.run(kv => kv.values({ container: this.#container, key: this.#key }));
    for (const [position, value] of values.entries()) {
      yield [position, this.#encoder.unpack(value) as T];
    }
  }

  async *valuesAsync(): AsyncIterableIterator<T> {
    for await (const [, val] of this.entriesAsync()) {
      yield val;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this.valuesAsync();
  }
}
