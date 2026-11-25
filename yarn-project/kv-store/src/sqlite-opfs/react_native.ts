import { type Logger, createLogger } from '@aztec-labs/foundation/log';
// eslint-disable-next-line import-x/no-extraneous-dependencies -- an optional peer dependency: the app provides it
import { type DB, type Scalar, open as openOpSqlite } from '@op-engineering/op-sqlite';

import { SqlitePoolBusyError, detectEncryptionCode } from './errors.js';
import type { SqlValue, WorkerRequest, WorkerResponse } from './messages.js';
import { DEFAULT_SAH_POOL_DIRECTORY } from './pool_lock.js';
import { SCHEMA_SQL } from './schema.js';
import { type SqliteWorkerPort, AztecSQLiteOPFSStore as WorkerStore } from './store.js';

export {
  SqliteCorruptionError,
  SqliteEncryptionError,
  SqlitePoolBusyError,
  SqliteWebLocksUnavailableError,
} from './errors.js';
export type { SqliteEncryptionErrorCode } from './errors.js';

/** The app's files, as @aztec-foundation/react-native installs them on the JavaScript runtime. */
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
 * The browser's sqlite-opfs store in a React Native app. The store and its containers are the browser's; its requests
 * run on op-sqlite, which the app must list in its own dependencies, with `"op-sqlite": { "sqlcipher": true }` in its
 * package.json for encrypted stores. A database is a file in the app's data directory
 * (`<data dir>/kv-store/<pool directory>/<name>`).
 */
export class AztecSQLiteOPFSStore extends WorkerStore {
  /**
   * Opens (or creates) a store, as the browser's does: `ephemeral` keeps it in memory; `poolDirectory` is the
   * directory holding its database, which one open store holds at a time (another open of it fails with
   * `SqlitePoolBusyError`); `encryptionKey` (32 bytes) encrypts it at rest with SQLCipher.
   */
  static override async open(
    log: Logger,
    name?: string,
    ephemeral: boolean = false,
    poolDirectory?: string,
    encryptionKey?: Uint8Array,
  ): Promise<WorkerStore> {
    const directory = ephemeral ? undefined : normalizePoolDirectory(poolDirectory ?? DEFAULT_SAH_POOL_DIRECTORY);
    const location = directory ? `${storesRoot()}/${directory}` : ':memory:';
    if (directory && openDirectories.has(directory)) {
      throw new SqlitePoolBusyError(directory);
    }
    const release = () => {
      if (directory) {
        openDirectories.delete(directory);
      }
    };
    if (directory) {
      openDirectories.add(directory);
    }
    try {
      return await WorkerStore.openOnPort(
        onResponse => connectOpSqlite(location, onResponse, release),
        log,
        name,
        ephemeral,
        directory,
        encryptionKey,
      );
    } catch (err) {
      release();
      throw err;
    }
  }
}

/**
 * Runs the store's requests on op-sqlite. op-sqlite runs a database's queries in order on one thread, so the
 * responses come back in the order of the requests.
 */
function connectOpSqlite(
  location: string,
  onResponse: (resp: WorkerResponse) => void,
  onTerminate: () => void,
): SqliteWorkerPort {
  let db: DB | undefined;
  const requireDb = () => {
    if (!db) {
      throw new Error('SQLite: no database open');
    }
    return db;
  };
  const closeDb = () => {
    try {
      db?.close();
    } finally {
      db = undefined;
    }
  };

  const handle = async (req: WorkerRequest): Promise<WorkerResponse> => {
    switch (req.type) {
      case 'init':
        db = openOpSqlite({
          name: req.dbName.replace(/^\/+/, ''),
          location,
          encryptionKey: req.encryptionKey && rawKey(req.encryptionKey),
        });
        await db.executeRaw(SCHEMA_SQL);
        return { type: 'ok', id: req.id };
      case 'close':
        closeDb();
        return { type: 'ok', id: req.id };
      case 'deleteDb':
        if (db && location !== ':memory:') {
          db.delete();
          db = undefined;
        }
        closeDb();
        return { type: 'ok', id: req.id };
      case 'run': {
        const { rowsAffected } = await requireDb().executeRaw(req.sql, req.bind?.map(toScalar));
        return { type: 'ok', id: req.id, changes: rowsAffected };
      }
      case 'all': {
        const { rawRows } = await requireDb().executeRaw(req.sql, req.bind?.map(toScalar));
        return { type: 'ok', id: req.id, rows: rawRows.map(row => row.map(fromScalar)) };
      }
      case 'export':
        throw new Error('exportDb is not supported on React Native');
      case 'begin':
        await requireDb().executeRaw('BEGIN');
        return { type: 'ok', id: req.id };
      case 'commit':
        await requireDb().executeRaw('COMMIT');
        return { type: 'ok', id: req.id };
      case 'rollback':
        await requireDb().executeRaw('ROLLBACK');
        return { type: 'ok', id: req.id };
    }
  };

  return {
    postMessage: req =>
      void handle(req).then(onResponse, (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (req.type === 'init') {
          try {
            closeDb();
          } catch {
            // The store terminates the port after a failed init.
          }
        }
        onResponse({ type: 'err', id: req.id, message, encryptionCode: detectEncryptionCode(req, err, message) });
      }),
    terminate: () => {
      try {
        closeDb();
      } catch {
        // Closing is best effort, as terminating the browser's worker is.
      }
      onTerminate();
    },
  };
}

/** The key in SQLCipher's raw-key form, so SQLCipher uses it as is rather than deriving one from it. */
function rawKey(key: Uint8Array): string {
  const hex = Array.from(key, b => b.toString(16).padStart(2, '0')).join('');
  key.fill(0);
  return `x'${hex}'`;
}

function toScalar(value: SqlValue): Scalar {
  if (typeof value === 'bigint') {
    throw new Error('op-sqlite cannot bind a bigint');
  }
  return value;
}

function fromScalar(value: Scalar): SqlValue {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return typeof value === 'boolean' ? Number(value) : value;
}

/** The effective names of the stores in the app's data directory, as the browser lists those in its origin. */
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

export function openTmpStore(ephemeral: boolean = false): Promise<WorkerStore> {
  return AztecSQLiteOPFSStore.open(createLogger('kv-store:sqlite'), undefined, ephemeral);
}

/** An encrypted store, in a directory of its own. The key must be 32 bytes. */
export function openEncryptedStore(encryptionKey: Uint8Array, name?: string, poolDirectory?: string) {
  return AztecSQLiteOPFSStore.open(createLogger('kv-store:sqlite'), name, false, poolDirectory, encryptionKey);
}
