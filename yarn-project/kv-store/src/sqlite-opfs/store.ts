import type { Logger } from '@aztec-labs/foundation/log';
import { AsyncApi, type KvCreateOptions } from '@aztec-labs/kv-sqlite';

import { AztecKvSqliteStore, typedInitError, validateEncryption } from '../kv-sqlite/store.js';
import type { WorkerRequest, WorkerResponse } from './messages.js';
import { quarantineDuplicatePool } from './pool_integrity.js';
import { type PoolLockLease, acquirePoolLock, normalizePoolDirectory } from './pool_lock.js';

type KvBackend = Exclude<KvCreateOptions['backend'], string | undefined>;

/**
 * Main-thread handle for a store persisted to OPFS: the Kv service's wasm module runs on a dedicated Web Worker
 * (OPFS sync access handles exist only there), keeping its files in an SAH pool directory in the layout SQLite's
 * opfs-sahpool VFS writes, so stores written before open unchanged. Every command is the generated client's bytes,
 * posted to the worker.
 */
export class AztecSQLiteOPFSStore extends AztecKvSqliteStore {
  private constructor(
    backend: WorkerBackend,
    log: Logger,
    isEphemeral: boolean,
    private readonly poolLock?: PoolLockLease,
  ) {
    super(new AsyncApi(backend), log, isEphemeral);
  }

  /**
   * Opens (or creates) a store in the OPFS SAH pool. When `ephemeral` is true the database lives only in memory and
   * is lost when the worker terminates. Pass `poolDirectory` to place the SAH pool in a non-default OPFS
   * subdirectory — required when multiple stores coexist in the same tab, because a pool's files are held by one
   * store at a time.
   *
   * Persistent stores hold an origin-wide Web Lock for the pool directory until close or delete. If another store
   * instance already owns it, open fails immediately with `SqlitePoolBusyError`.
   *
   * Pass `encryptionKey` (exactly 32 bytes) to enable at-rest encryption via sqlite3mc's ChaCha20 page cipher. The
   * key buffer is **transferred** to the worker — its ArrayBuffer detaches on the caller side after `postMessage`.
   * This is intentional: the API encodes a one-key-one-owner invariant. A caller that wants to use the same key for
   * multiple stores must explicitly clone it per call (e.g. `new Uint8Array(savedKey)`), making the duplication a
   * visible, deliberate decision rather than a silent structured-clone operation. The default path (one `.open()`,
   * one consumption of the key) leaves zero key bytes on the main thread after the call.
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
    log.debug(
      `Opening SQLite-OPFS ${ephemeral ? 'ephemeral ' : ''}${encryptionKey ? 'encrypted ' : ''}database ${dbName}`,
    );
    const effectivePoolDirectory = ephemeral ? undefined : normalizePoolDirectory(poolDirectory);
    const poolLock = effectivePoolDirectory ? await acquirePoolLock(effectivePoolDirectory) : undefined;
    let backend: WorkerBackend | undefined;
    try {
      if (effectivePoolDirectory) {
        const quarantine = await quarantineDuplicatePool(effectivePoolDirectory);
        if (quarantine) {
          log.warn(`Quarantined SQLite-OPFS pool with duplicate logical file mappings`, quarantine);
        }
      }
      // @dependency ./worker.ts
      backend = new WorkerBackend(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }), log);
      await backend
        .request(
          {
            type: 'open',
            id: 0,
            path: ephemeral ? undefined : normalizeDbPath(dbName),
            poolDirectory: effectivePoolDirectory,
            encryptionKey,
          },
          // Transfer (not clone) the key buffer to the worker so we don't leave a second copy on the main thread.
          encryptionKey ? [encryptionKey.buffer as ArrayBuffer] : undefined,
        )
        .catch(err => {
          throw typedInitError(err);
        });
      return new AztecSQLiteOPFSStore(backend, log, ephemeral, poolLock);
    } catch (err) {
      backend?.terminate();
      await poolLock?.release();
      throw err;
    }
  }

  protected override async release(): Promise<void> {
    try {
      await super.release();
    } finally {
      await this.poolLock?.release();
    }
  }
}

/** The Kv service's backend on the store's worker: each call posts the command's bytes and awaits the answer's. */
class WorkerBackend implements KvBackend {
  readonly #pending = new Map<number, { resolve: (bytes: Uint8Array) => void; reject: (err: Error) => void }>();
  #nextId = 0;
  #failed: string | undefined;

  constructor(
    private readonly worker: Worker,
    private readonly log: Logger,
  ) {
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const resp = ev.data;
      const handler = this.#pending.get(resp.id);
      if (!handler) {
        this.log.warn(`SQLite worker: no pending handler for id ${resp.id}`);
        return;
      }
      this.#pending.delete(resp.id);
      if (resp.type === 'err') {
        handler.reject(new Error(resp.message));
      } else {
        handler.resolve(resp.bytes ?? new Uint8Array());
      }
    };
    worker.onerror = ev => {
      this.#failed = `SQLite worker crashed: ${ev.message}`;
      this.log.error(this.#failed);
      this.#rejectPending(this.#failed);
    };
  }

  call(bytes: Uint8Array): Promise<Uint8Array> {
    return this.request({ type: 'call', id: 0, bytes });
  }

  /** Ends the service (releasing the pool's handles before it answers), then the worker. */
  async destroy(): Promise<void> {
    try {
      if (!this.#failed) {
        await this.request({ type: 'close', id: 0 }).catch(() => {});
      }
    } finally {
      this.terminate();
    }
  }

  terminate(): void {
    this.worker.terminate();
    this.#failed ??= 'SQLite store closed';
    this.#rejectPending(this.#failed);
  }

  request(req: WorkerRequest, transfer?: Transferable[]): Promise<Uint8Array> {
    if (this.#failed) {
      return Promise.reject(new Error(this.#failed));
    }
    const id = ++this.#nextId;
    return new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id }, transfer ?? []);
    });
  }

  /**
   * Rejects every in-flight request with `reason`, so callers awaiting a worker that has ended don't hang forever.
   */
  #rejectPending(reason: string): void {
    const err = new Error(reason);
    for (const { reject } of this.#pending.values()) {
      reject(err);
    }
    this.#pending.clear();
  }
}

function normalizeDbPath(dbName: string): string {
  return dbName.startsWith('/') ? dbName : `/${dbName}`;
}
