import type { Key, Range } from '../interfaces/common.js';
import type { AztecAsyncSet } from '../interfaces/set.js';
import { KvSqliteAztecMap } from './map.js';
import type { AztecKvSqliteStore } from './store.js';

/** A set over the Kv service: a Map<K, true>. */
export class KvSqliteAztecSet<K extends Key> implements AztecAsyncSet<K> {
  readonly #map: KvSqliteAztecMap<K, boolean>;

  constructor(store: AztecKvSqliteStore, name: string) {
    this.#map = new KvSqliteAztecMap<K, boolean>(store, name);
  }

  hasAsync(key: K): Promise<boolean> {
    return this.#map.hasAsync(key);
  }

  add(key: K): Promise<void> {
    return this.#map.set(key, true);
  }

  delete(key: K): Promise<void> {
    return this.#map.delete(key);
  }

  async *entriesAsync(range: Range<K> = {}): AsyncIterableIterator<K> {
    yield* this.#map.keysAsync(range);
  }
}
