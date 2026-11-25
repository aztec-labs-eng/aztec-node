import { toArray } from '@aztec-labs/foundation/iterable';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeAztecArray } from '../interfaces/array_test_suite.js';
import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { describeAztecMultiMap } from '../interfaces/multi_map_test_suite.js';
import { describeAztecSet } from '../interfaces/set_test_suite.js';
import { describeAztecSingleton } from '../interfaces/singleton_test_suite.js';
import { mockLogger } from '../interfaces/utils.js';
import { SqliteEncryptionError } from './errors.js';
import { AztecKvSqliteStore } from './store.js';

// The React Native store (sqlite-opfs/react_native.ts) runs these containers over the library linked into the app;
// these run them over each node backend, in memory.
for (const backend of ['process', 'napi'] as const) {
  describe(`AztecKvSqliteStore (${backend})`, () => {
    const open = () => AztecKvSqliteStore.create(mockLogger, { backend });
    describeAztecMap('AztecMap', open);
    describeAztecMultiMap('AztecMultiMap', open);
    describeAztecArray('AztecArray', open);
    describeAztecSet('AztecSet', open);
    describeAztecSingleton('AztecSingleton', open);

    it('holds the same value more than once in an array', async () => {
      const store = await open();
      const arr = store.openArray<number>('arr');
      await arr.push(7, 7);
      await arr.push(7);
      await arr.setAt(0, 8);
      await arr.setAt(1, 7);

      expect(await toArray(arr.valuesAsync())).toEqual([8, 7, 7]);
      expect(await arr.pop()).toBe(7);
      expect(await toArray(arr.valuesAsync())).toEqual([8, 7]);
      await store.close();
    });
  });
}

describe('AztecKvSqliteStore on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kv-sqlite-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reopens with its data, and is encrypted only with the key it was written with', async () => {
    const path = join(dir, 'store.sqlite');
    const key = () => new Uint8Array(32).fill(5);
    const a = await AztecKvSqliteStore.create(mockLogger, { path, encryptionKey: key() });
    await a.openMap<string, string>('m').set('k', 'v');
    await a.openMultiMap<string, string>('mm').set('k', 'x');
    await a.close();

    await expect(AztecKvSqliteStore.create(mockLogger, { path })).rejects.toMatchObject({
      name: 'SqliteEncryptionError',
      code: 'decrypt_failed',
    });
    await expect(
      AztecKvSqliteStore.create(mockLogger, { path, encryptionKey: new Uint8Array(32).fill(6) }),
    ).rejects.toBeInstanceOf(SqliteEncryptionError);

    const b = await AztecKvSqliteStore.create(mockLogger, { path, encryptionKey: key() });
    expect(await b.openMap<string, string>('m').getAsync('k')).toBe('v');
    await b.openMultiMap<string, string>('mm').set('k', 'x');
    expect(await b.openMultiMap<string, string>('mm').getValueCountAsync('k')).toBe(1);
    await b.delete();
  });

  it('rolls back a failed transaction', async () => {
    const store = await AztecKvSqliteStore.create(mockLogger, { path: join(dir, 'tx.sqlite') });
    const map = store.openMap<string, number>('m');
    await map.set('a', 1);
    await expect(
      store.transactionAsync(async () => {
        await map.set('a', 2);
        await map.set('b', 2);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await map.getAsync('a')).toBe(1);
    expect(await map.hasAsync('b')).toBe(false);
    const exported = await store.exportDb();
    expect(new TextDecoder().decode(exported.subarray(0, 15))).toBe('SQLite format 3');
    await store.close();
  });

  it('rejects a key it cannot use before opening anything', async () => {
    await expect(
      AztecKvSqliteStore.create(mockLogger, { path: join(dir, 'x.sqlite'), encryptionKey: new Uint8Array(16) }),
    ).rejects.toMatchObject({ code: 'invalid_key_length' });
    await expect(AztecKvSqliteStore.create(mockLogger, { encryptionKey: new Uint8Array(32) })).rejects.toMatchObject({
      code: 'encryption_not_supported_for_ephemeral',
    });
  });
});
