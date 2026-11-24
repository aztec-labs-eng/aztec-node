import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { KvService } from '@aztec-labs/kv-sqlite';

import { AztecKvSqliteStore, initStore, validateEncryption } from '../kv-sqlite/store.js';
import { SqlitePoolBusyError } from './errors.js';

export {
  SqliteCorruptionError,
  SqliteEncryptionError,
  SqlitePoolBusyError,
  SqliteWebLocksUnavailableError,
} from './errors.js';
export type { SqliteEncryptionErrorCode } from './errors.js';

/**
 * The app's files, as @aztec-foundation/react-native installs them on the JavaScript runtime. The store needs the app
 * to have imported that package, which links the Kv service's library into the app.
 */
interface ReactNativeFiles {
  dataDir: string;
  isDirectory(path: string): boolean;
  listDirectory(path: string): string[];
  removeDirectory(path: string): void;
}

function files(): ReactNativeFiles {
  const native = (globalThis as { __aztecReactNative?: ReactNativeFiles }).__aztecReactNative;
  if (!native) {
    throw new Error("The store needs @aztec-foundation/react-native: import it first in the app's entry file");
  }
  return native;
}

/** Prefix for the per-store directories, as the browser names its OPFS pool directories. */
export const OPFS_POOL_DIR_PREFIX = '.aztec-kv-';

/** Where the stores live: a directory of the app's data directory. */
function storesRoot(): string {
  return `${files().dataDir}/kv-store`;
}

/** The directory holding a store's database, by the store's effective name. */
export function storePoolDirectory(effectiveName: string): string {
  return `${OPFS_POOL_DIR_PREFIX}${effectiveName}`;
}

function normalizePoolDirectory(poolDirectory: string): string {
  const normalized = poolDirectory.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`Invalid store directory "${poolDirectory}"`);
  }
  return normalized;
}

/** The directories of the stores open in this app: one store holds a directory at a time, as in the browser. */
const openDirectories = new Set<string>();

/**
 * The browser's sqlite-opfs store in a React Native app: the Kv service's library linked into the app, reached
 * through JSI, and its database a file in the app's data directory (`<data dir>/kv-store/<pool directory>/<name>`).
 * The API is the browser's, so the PXE and the embedded wallet open it unchanged.
 */
export class AztecSQLiteOPFSStore extends AztecKvSqliteStore {
  private constructor(
    kv: KvService,
    log: Logger,
    isEphemeral: boolean,
    private readonly directory?: string,
  ) {
    super(kv, log, isEphemeral);
  }

  /**
   * Opens (or creates) a store, as the browser's does: `ephemeral` keeps it in memory; `poolDirectory` is the
   * directory holding its database, which one open store holds at a time (another open of it fails with
   * `SqlitePoolBusyError`); `encryptionKey` (32 bytes) encrypts it at rest.
   */
  static async open(
    log: Logger,
    name?: string,
    ephemeral: boolean = false,
    poolDirectory?: string,
    encryptionKey?: Uint8Array,
  ): Promise<AztecSQLiteOPFSStore> {
    validateEncryption(encryptionKey, ephemeral);
    const dbName = name && !ephemeral ? name : `tmp-${globalThis.crypto.getRandomValues(new Uint8Array(8)).join('')}`;
    const directory = ephemeral ? undefined : normalizePoolDirectory(poolDirectory ?? storePoolDirectory(dbName));
    if (directory && openDirectories.has(directory)) {
      throw new SqlitePoolBusyError(directory);
    }
    const path = directory ? `${storesRoot()}/${directory}/${dbName.replace(/^\/+/, '')}` : undefined;
    log.debug(`Opening SQLite ${ephemeral ? 'ephemeral ' : ''}${encryptionKey ? 'encrypted ' : ''}database ${dbName}`);
    if (directory) {
      openDirectories.add(directory);
    }
    try {
      const kv = await KvService.create();
      try {
        await initStore(kv, path, encryptionKey);
      } catch (err) {
        await kv.destroy().catch(() => {});
        throw err;
      }
      return new AztecSQLiteOPFSStore(kv, log, ephemeral, directory);
    } catch (err) {
      if (directory) {
        openDirectories.delete(directory);
      }
      throw err;
    }
  }

  protected override async release(): Promise<void> {
    try {
      await super.release();
    } finally {
      if (this.directory) {
        openDirectories.delete(this.directory);
      }
    }
  }
}

/** The effective names of the stores in the app's data directory, as the browser's lists those in its origin. */
// eslint-disable-next-line require-await -- async so a failure rejects, as in the browser, rather than throwing
export async function listStores(): Promise<string[]> {
  const root = storesRoot();
  const names = files().isDirectory(root) ? files().listDirectory(root) : [];
  return names
    .filter(name => name.startsWith(OPFS_POOL_DIR_PREFIX) && files().isDirectory(`${root}/${name}`))
    .map(name => name.slice(OPFS_POOL_DIR_PREFIX.length));
}

/** Permanently deletes a store by effective name. The store must be closed. */
export function deleteStore(effectiveName: string): Promise<void> {
  return deletePoolDirectory(storePoolDirectory(effectiveName));
}

/** Permanently deletes a store's directory. Its store must be closed. */
// eslint-disable-next-line require-await -- async so a failure rejects, as in the browser, rather than throwing
export async function deletePoolDirectory(poolDirectory: string): Promise<void> {
  const directory = normalizePoolDirectory(poolDirectory);
  if (openDirectories.has(directory)) {
    throw new SqlitePoolBusyError(directory);
  }
  files().removeDirectory(`${storesRoot()}/${directory}`);
}

export function openTmpStore(ephemeral: boolean = false): Promise<AztecSQLiteOPFSStore> {
  return AztecSQLiteOPFSStore.open(createLogger('kv-store:sqlite'), undefined, ephemeral);
}

/** An encrypted store, in a directory of its own. The key must be 32 bytes. */
export function openEncryptedStore(encryptionKey: Uint8Array, name?: string, poolDirectory?: string) {
  return AztecSQLiteOPFSStore.open(createLogger('kv-store:sqlite'), name, false, poolDirectory, encryptionKey);
}
