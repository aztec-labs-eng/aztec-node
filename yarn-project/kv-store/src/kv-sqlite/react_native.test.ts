import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { mockLogger } from '../interfaces/utils.js';
import {
  AztecSQLiteOPFSStore,
  SqliteEncryptionError,
  SqlitePoolBusyError,
  deleteStore,
  listStores,
  openTmpStore,
  storePoolDirectory,
} from '../sqlite-opfs/react_native.js';

// The browser store's React Native form, with the app's files (which @aztec-foundation/react-native installs) over
// Node's; the Kv service runs on its node backend here, on the library linked into the app there.
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

  it('says what is missing when the app has not imported @aztec-foundation/react-native', async () => {
    delete (globalThis as any).__aztecReactNative;
    await expect(open('x')).rejects.toThrow(/@aztec-foundation\/react-native/);
  });
});
