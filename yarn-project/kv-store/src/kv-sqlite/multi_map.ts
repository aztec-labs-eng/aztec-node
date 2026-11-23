import type { Key, Value } from '../interfaces/common.js';
import type { AztecAsyncMultiMap } from '../interfaces/multi_map.js';
import { KvSqliteAztecMap } from './map.js';

/**
 * A multimap over the Kv service: each value is appended at its key's next index, which always increments, so an
 * index is never reused across deletions — matching the IndexedDB backend's sparse multimap. A value the key already
 * holds is not added again.
 */
export class KvSqliteAztecMultiMap<K extends Key, V extends Value>
  extends KvSqliteAztecMap<K, V>
  implements AztecAsyncMultiMap<K, V>
{
  override async set(key: K, val: V): Promise<void> {
    await this.store.run(kv =>
      kv.append({
        container: this.container,
        key: this.encodedKey(key),
        values: [this.encoder.pack(val)],
        unique: true,
      }),
    );
  }

  async *getValuesAsync(key: K): AsyncIterableIterator<V> {
    const { values } = await this.store.run(kv => kv.values({ container: this.container, key: this.encodedKey(key) }));
    for (const value of values) {
      yield this.decodeValue(value);
    }
  }

  async getValueCountAsync(key: K): Promise<number> {
    return Number(
      (await this.store.run(kv => kv.count({ container: this.container, key: this.encodedKey(key) }))).count,
    );
  }

  async deleteValue(key: K, val: V): Promise<void> {
    await this.store.run(kv =>
      kv.deleteValue({ container: this.container, key: this.encodedKey(key), value: this.encoder.pack(val) }),
    );
  }
}
