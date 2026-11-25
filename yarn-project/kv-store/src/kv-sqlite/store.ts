import type { Logger } from '@aztec-labs/foundation/log';
import { SerialQueue } from '@aztec-labs/foundation/queue';
import { type AsyncApi, type KvCreateOptions, KvService } from '@aztec-labs/kv-sqlite';

import type { AztecAsyncArray } from '../interfaces/array.js';
import type { Key, StoreSize, Value } from '../interfaces/common.js';
import type { AztecAsyncCounter } from '../interfaces/counter.js';
import type { AztecAsyncMap } from '../interfaces/map.js';
import type { AztecAsyncMultiMap } from '../interfaces/multi_map.js';
import type { AztecAsyncSet } from '../interfaces/set.js';
import type { AztecAsyncSingleton } from '../interfaces/singleton.js';
import type { AztecAsyncKVStore } from '../interfaces/store.js';
import { KvSqliteAztecArray } from './array.js';
import {
  SqliteCorruptionError,
  SqliteEncryptionError,
  isCorruptionMessage,
  isDecryptFailureMessage,
} from './errors.js';
import { KvSqliteAztecMap } from './map.js';
import { KvSqliteAztecMultiMap } from './multi_map.js';
import { KvSqliteAztecSet } from './set.js';
import { KvSqliteAztecSingleton } from './singleton.js';

/** The Kv service a store runs its commands on: the generated client over any of its backends. */
export type KvClient = AsyncApi;

/** Options for {@link AztecKvSqliteStore.create}. */
export interface KvSqliteStoreOptions {
  /** The database file; without one the store lives in memory and ends when it closes. */
  path?: string;
  /** 32 bytes: the database is encrypted at rest (sqlite3mc's ChaCha20). Persistent stores only. */
  encryptionKey?: Uint8Array;
  /**
   * The Kv service's backend: one of @aztec-labs/kv-sqlite's ('process', 'napi', or 'jsi' in React Native),
   * or a backend object. Default: the package's own choice for the platform.
   */
  backend?: KvCreateOptions['backend'];
}

/**
 * A key-value store over the Kv service (@aztec-labs/kv-sqlite): SQLite3 Multiple Ciphers, in whichever form the
 * platform runs it (a native library or process, or the library through JSI in React Native). Every
 * container is rows of the service's one table, so a database opens the same in each.
 *
 * Commands are ordered by a `SerialQueue`: outside a `transactionAsync` block each command takes the queue for its
 * own auto-commit; inside one, the block holds the queue and its commands bypass it.
 */
export class AztecKvSqliteStore implements AztecAsyncKVStore {
  readonly #txQueue = new SerialQueue();
  #inTx = false;
  #closed = false;

  protected constructor(
    protected readonly kv: KvClient,
    protected readonly log: Logger,
    public readonly isEphemeral: boolean,
  ) {
    this.#txQueue.start();
  }

  /**
   * Opens (or creates) the store at `options.path`, or an ephemeral one in memory. Throws
   * {@link SqliteEncryptionError} for a key that is not 32 bytes, a key on an ephemeral store, or a database that
   * the key (or no key) does not decrypt.
   */
  static async create(log: Logger, options: KvSqliteStoreOptions = {}): Promise<AztecKvSqliteStore> {
    validateEncryption(options.encryptionKey, !options.path);
    const kv = await KvService.create({ backend: options.backend });
    try {
      await initStore(kv, options.path, options.encryptionKey);
    } catch (err) {
      await kv.destroy().catch(() => {});
      throw err;
    }
    return new AztecKvSqliteStore(kv, log, !options.path);
  }

  openMap<K extends Key, V extends Value>(name: string): AztecAsyncMap<K, V> {
    return new KvSqliteAztecMap<K, V>(this, name);
  }

  openSet<K extends Key>(name: string): AztecAsyncSet<K> {
    return new KvSqliteAztecSet<K>(this, name);
  }

  openMultiMap<K extends Key, V extends Value>(name: string): AztecAsyncMultiMap<K, V> {
    return new KvSqliteAztecMultiMap<K, V>(this, name);
  }

  openCounter<K extends Key>(_name: string): AztecAsyncCounter<K> {
    throw new Error('Method not implemented.');
  }

  openArray<T extends Value>(name: string): AztecAsyncArray<T> {
    return new KvSqliteAztecArray<T>(this, name);
  }

  openSingleton<T extends Value>(name: string): AztecAsyncSingleton<T> {
    return new KvSqliteAztecSingleton<T>(this, name);
  }

  transactionAsync<T>(callback: () => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction — SQLite does not support nested BEGIN,
    // and re-acquiring the SerialQueue while the outer call holds it would deadlock.
    // Errors in the nested callback propagate to the outer catch, which rolls back the
    // whole thing (the standard "nested tx = savepoint-free join" semantic).
    if (this.#inTx) {
      return callback();
    }
    return this.#txQueue.put(async () => {
      this.#inTx = true;
      await this.#call(kv => kv.begin({}));
      try {
        const result = await callback();
        await this.#call(kv => kv.commit({}));
        return result;
      } catch (err) {
        await this.#call(kv => kv.rollback({})).catch(rollbackErr =>
          this.log.warn(`SQLite ROLLBACK failed: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`),
        );
        throw err;
      } finally {
        this.#inTx = false;
      }
    });
  }

  /**
   * Runs `command` on the Kv service: in the current transaction inside a `transactionAsync` block, otherwise in
   * its own auto-commit, after every command queued before it.
   */
  run<T>(command: (kv: KvClient) => Promise<T>): Promise<T> {
    return this.#inTx ? this.#call(command) : this.#txQueue.put(() => this.#call(command));
  }

  async clear(): Promise<void> {
    await this.run(kv => kv.clear({}));
  }

  async delete(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#txQueue.end();
      await this.#call(kv => kv.deleteStore({})).catch(err =>
        this.log.warn(`SQLite deleteStore failed: ${err instanceof Error ? err.message : err}`),
      );
    } finally {
      await this.release();
    }
  }

  /**
   * Placeholder — returns zeros to mirror the IndexedDB backend. All current consumers tolerate zeros; the Kv
   * service would need a command to report real numbers.
   */
  estimateSize(): Promise<StoreSize> {
    return Promise.resolve({ mappingSize: 0, physicalFileSize: 0, actualSize: 0, numItems: 0 });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#txQueue.end();
    } finally {
      await this.release();
    }
  }

  backupTo(_dstPath: string, _compact?: boolean): Promise<void> {
    throw new Error('Method not implemented.');
  }

  /**
   * Returns a raw SQLite image (bytes suitable for writing as a `.sqlite` file and opening in any SQLite tool).
   * Works only for persistent stores. Useful for inspection/debugging.
   */
  async exportDb(): Promise<Uint8Array> {
    return (await this.run(kv => kv.export({}))).bytes;
  }

  /** Ends the Kv service, and with it everything the store holds. */
  protected async release(): Promise<void> {
    await this.kv.destroy().catch(err => this.log.warn(`Kv service shutdown failed: ${err?.message ?? err}`));
  }

  async #call<T>(command: (kv: KvClient) => Promise<T>): Promise<T> {
    try {
      return await command(this.kv);
    } catch (err) {
      throw typedError(err);
    }
  }
}

/** Throws the {@link SqliteEncryptionError} a key that can't be used is, before any service sees it. */
export function validateEncryption(encryptionKey: Uint8Array | undefined, ephemeral: boolean): void {
  if (encryptionKey !== undefined && encryptionKey.length !== 32) {
    throw new SqliteEncryptionError(
      'invalid_key_length',
      `encryptionKey must be 32 bytes (got ${encryptionKey.length})`,
    );
  }
  if (encryptionKey !== undefined && ephemeral) {
    throw new SqliteEncryptionError(
      'encryption_not_supported_for_ephemeral',
      'encryptionKey is not supported for ephemeral (:memory:) stores',
    );
  }
}

/**
 * Opens the service's store. A database the key does not decrypt — the wrong key, or none for an encrypted one —
 * reads as SQLITE_NOTADB, which is the typed `decrypt_failed`.
 */
export async function initStore(
  kv: { init: KvClient['init'] },
  path: string | undefined,
  encryptionKey: Uint8Array | undefined,
): Promise<void> {
  try {
    await kv.init({ path: path ?? null, encryptionKey: encryptionKey ?? null });
  } catch (err) {
    throw typedInitError(err);
  }
}

/** A failed Init as the typed error its message says it is. */
export function typedInitError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (isDecryptFailureMessage(message)) {
    return new SqliteEncryptionError('decrypt_failed', message, { cause: err });
  }
  return typedError(err);
}

function typedError(err: unknown): unknown {
  if (err instanceof Error && isCorruptionMessage(err.message)) {
    return new SqliteCorruptionError(err.message, { cause: err });
  }
  return err;
}
