import { toArray } from '@aztec-labs/foundation/iterable';
import { commands } from 'vitest/browser';

import { mockLogger } from '../interfaces/utils.js';
import { AztecSQLiteOPFSStore } from './index.js';
import { deleteStore, storePoolDirectory } from './manage.js';

// Fixtures are whole SAH pool directories that sqlite3mc 2.3.5 (SQLite 3.53.2) wrote, as gzipped
// `{ relativePath: base64 }` JSON.
const FIXTURE_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

async function restorePool(name: string): Promise<void> {
  const gzipped = await commands.readFile(`src/sqlite-opfs/fixtures/sqlite3mc-2.3.5-${name}.json.gz`, 'base64');
  const json = await new Response(
    new Blob([Uint8Array.from(atob(gzipped), c => c.charCodeAt(0))])
      .stream()
      .pipeThrough(new DecompressionStream('gzip')),
  ).text();
  const root = await navigator.storage.getDirectory();
  const pool = await root.getDirectoryHandle(storePoolDirectory(name), { create: true });
  for (const [path, base64] of Object.entries<string>(JSON.parse(json))) {
    const segments = path.split('/');
    let dir = pool;
    for (const segment of segments.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
    const writable = await (await dir.getFileHandle(segments.at(-1)!, { create: true })).createWritable();
    await writable.write(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    await writable.close();
  }
}

describe('sqlite-opfs stores written by an older sqlite3mc', () => {
  it.each([
    ['compat_plain', undefined],
    ['compat_encrypted', FIXTURE_KEY],
  ])('opens %s and reads and writes its data', async (name, key) => {
    await restorePool(name);
    const store = await AztecSQLiteOPFSStore.open(
      mockLogger,
      name,
      false,
      storePoolDirectory(name),
      key && new Uint8Array(key),
    );

    const map = store.openMap<number, string>('map');
    expect(await toArray(map.valuesAsync())).toEqual(Array.from({ length: 100 }, (_, i) => `value-${i}`));
    expect(await store.openSingleton<string>('singleton').getAsync()).toEqual('singleton');
    expect(await toArray(store.openMultiMap<string, string>('multimap').getValuesAsync('k'))).toEqual(['a', 'b', 'c']);
    expect(await toArray(store.openSet<string>('set').entriesAsync())).toEqual(['x', 'y']);
    expect(await toArray(store.openArray<number>('array').valuesAsync())).toEqual([1, 2, 3]);

    await map.set(100, 'value-100');
    expect(await map.getAsync(100)).toEqual('value-100');
    await store.close();
    await deleteStore(name);
  });
});
