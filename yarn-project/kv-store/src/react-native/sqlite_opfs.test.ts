import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

import { describeAztecArray } from '../interfaces/array_test_suite.js';
import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { describeAztecMultiMap } from '../interfaces/multi_map_test_suite.js';
import { describeAztecSet } from '../interfaces/set_test_suite.js';
import { describeAztecSingleton } from '../interfaces/singleton_test_suite.js';
import { mockLogger } from '../interfaces/utils.js';
import {
  AztecSQLiteOPFSStore,
  SqliteEncryptionError,
  SqlitePoolBusyError,
  deletePoolDirectory,
  deleteStore,
  listStores,
  openTmpStore,
  storePoolDirectory,
} from '../sqlite-opfs/react_native.js';

// op-sqlite runs only in an app, so node:sqlite stands in for it. node:sqlite has no SQLCipher: the fake keeps a
// database's key beside it and fails a wrong or missing key as SQLCipher does, on the first statement.
vi.mock('@op-engineering/op-sqlite', () => ({
  open: ({ name, location, encryptionKey }: { name: string; location: string; encryptionKey?: string }) => {
    const path = location === ':memory:' ? location : join(location, name);
    const keyPath = `${path}.key`;
    if (path !== ':memory:') {
      mkdirSync(location, { recursive: true });
      if (encryptionKey && !existsSync(path)) {
        writeFileSync(keyPath, encryptionKey);
      }
    }
    const storedKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : undefined;
    const db = new DatabaseSync(path);
    return {
      executeRaw: (sql: string, params: SQLInputValue[] = []) => {
        if (storedKey !== encryptionKey) {
          return Promise.reject(new Error('file is not a database'));
        }
        if (params.length === 0 && sql.includes(';')) {
          db.exec(sql);
          return Promise.resolve({ rowsAffected: 0, rawRows: [] });
        }
        // op-sqlite returns blobs as ArrayBuffers.
        const rows = db
          .prepare(sql)
          .all(...params)
          .map(row => Object.values(row).map(value => (value instanceof Uint8Array ? value.slice().buffer : value)));
        const { changes } = db.prepare('SELECT changes() AS changes').get() as { changes: number };
        return Promise.resolve({ rowsAffected: changes, rawRows: rows });
      },
      close: () => db.close(),
      delete: () => {
        db.close();
        rmSync(path, { force: true });
        rmSync(keyPath, { force: true });
      },
    };
  },
}));

// The browser store's React Native form, with the app's files (which @aztec-foundation/react-native installs) over
// Node's.
describe('AztecSQLiteOPFSStore (React Native)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'kv-store-rn-'));
    (globalThis as any).__aztecReactNative = {
      dataDir,
      isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
      listDirectory: (path: string) => readdirSync(path),
      removeDirectory: (path: string) => rmSync(path, { recursive: true, force: true }),
    };
  });
  afterEach(() => {
    delete (globalThis as any).__aztecReactNative;
    rmSync(dataDir, { recursive: true, force: true });
  });

  describeAztecMap('AztecMap', () => openTmpStore(true));
  describeAztecMultiMap('AztecMultiMap', () => openTmpStore(true));
  describeAztecArray('AztecArray', () => openTmpStore(true));
  describeAztecSet('AztecSet', () => openTmpStore(true));
  describeAztecSingleton('AztecSingleton', () => openTmpStore(true));

  const key = () => new Uint8Array(32).fill(3);
  const open = (name: string, encryptionKey?: Uint8Array) =>
    AztecSQLiteOPFSStore.open(mockLogger, name, false, storePoolDirectory(name), encryptionKey);

  it('keeps a store in the data directory, encrypted, and lists and deletes it as the browser does', async () => {
    const a = await open('pxe_data_1', key());
    await a.openMap<string, string>('m').set('k', 'v');
    await expect(open('pxe_data_1', key())).rejects.toBeInstanceOf(SqlitePoolBusyError);
    await a.close();

    expect(existsSync(join(dataDir, 'kv-store', '.aztec-kv-pxe_data_1', 'pxe_data_1'))).toBe(true);
    expect(await listStores()).toEqual(['pxe_data_1']);
    await expect(open('pxe_data_1', new Uint8Array(32).fill(4))).rejects.toBeInstanceOf(SqliteEncryptionError);

    const b = await open('pxe_data_1', key());
    expect(await b.openMap<string, string>('m').getAsync('k')).toBe('v');
    await expect(deleteStore('pxe_data_1')).rejects.toBeInstanceOf(SqlitePoolBusyError);
    await b.close();

    await deleteStore('pxe_data_1');
    expect(await listStores()).toEqual([]);
  });

  it('lists only store directories', async () => {
    mkdirSync(join(dataDir, 'kv-store'), { recursive: true });
    writeFileSync(join(dataDir, 'kv-store', '.aztec-kv-stray'), '');
    expect(await listStores()).toEqual([]);
  });

  it('rejects, as the browser does, rather than throwing when it cannot delete a directory', async () => {
    await expect(deletePoolDirectory('..')).rejects.toThrow(/Invalid store directory/);
  });

  it('says what is missing when the app has not imported @aztec-foundation/react-native', async () => {
    delete (globalThis as any).__aztecReactNative;
    await expect(open('x')).rejects.toThrow(/@aztec-foundation\/react-native/);
  });
});
