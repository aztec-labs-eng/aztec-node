import { Encoder } from '#msgpackr';
import { toBufferKey } from '#ordered-binary';
import type { Buffer } from 'buffer';

import type { Value } from '../interfaces/common.js';
import type { AztecAsyncSingleton } from '../interfaces/singleton.js';
import type { AztecKvSqliteStore } from './store.js';

/** A single value over the Kv service, in the container `singleton:<name>`. */
export class KvSqliteAztecSingleton<T extends Value> implements AztecAsyncSingleton<T> {
  readonly #container: string;
  // The key the browser store has always written a singleton under.
  readonly #key: Buffer;
  readonly #encoder = new Encoder();

  constructor(
    private readonly store: AztecKvSqliteStore,
    name: string,
  ) {
    this.#container = `singleton:${name}`;
    this.#key = toBufferKey([`singleton:${name}:value`]);
  }

  async getAsync(): Promise<T | undefined> {
    const { values } = await this.store.run(kv => kv.get({ container: this.#container, keys: [this.#key] }));
    const value = values[0]?.value;
    return value == null ? undefined : (this.#encoder.unpack(value) as T);
  }

  async set(val: T): Promise<boolean> {
    await this.store.run(kv => kv.put({ container: this.#container, key: this.#key, value: this.#encoder.pack(val) }));
    return true;
  }

  async delete(): Promise<boolean> {
    await this.store.run(kv => kv.delete({ container: this.#container, key: this.#key }));
    return true;
  }
}
