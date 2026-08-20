import { Semaphore } from '@aztec/foundation/queue';
import type { AztecAsyncKVStore } from '@aztec/kv-store';

import type { Rollbackable } from './rollbackable.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- StagedWriteCoordinator is only used in doc tags
import type { ChangeSetId, StagedStore, StagedWriteCoordinator } from './staged_write_coordinator.js';

/**
 * Base class for stores that stage their writes per change set, flushing them on commit and dropping them on abort.
 *
 * A change set's staged data exists only between {@link beginChangeSet} and {@link commitStaged}/
 * {@link discardStaged}. An operation arriving on behalf of a change set that already ended (e.g. one discarded on
 * abort) finds no matching change set and throws, so it cannot stage new data for a dead one.
 *
 * The staged data and the store's kv handles live in this base class and are only reachable through
 * {@link withStaging} (change set operations, with the DB read-only), {@link flushStaged} (the commit-time
 * write-back) and {@link applyRollback} (the reorg truncation).
 */
export abstract class BaseStagingStore<TStaging, TDb> implements StagedStore, Rollbackable {
  public readonly storeName: string;

  readonly #store: AztecAsyncKVStore;
  readonly #db: TDb;
  readonly #buildStaging: () => TStaging;
  readonly #lock = new Semaphore(1);

  /** The change set currently open, if any. */
  #current: OpenChangeSet<TStaging> | undefined;

  protected constructor({
    storeName,
    store,
    buildStaging,
    buildDb,
  }: {
    /** Unique name identifying this store, used in error messages and for registration with StagedWriteCoordinator. */
    storeName: string;
    /** The backing kv store; the runners open their transactions on it. */
    store: AztecAsyncKVStore;
    /** Creates the empty staged data a change set starts with. */
    buildStaging: () => TStaging;
    /** Opens the store's kv handles. */
    buildDb: (store: AztecAsyncKVStore) => TDb;
  }) {
    this.storeName = storeName;
    this.#store = store;
    this.#buildStaging = buildStaging;
    this.#db = buildDb(store);
  }

  /**
   * Opens the change set, so its operations are accepted until {@link commitStaged} or {@link discardStaged}.
   *
   * @throws If a change set is already open: opening another would silently discard its staged data.
   */
  beginChangeSet(changeSetId: ChangeSetId): void {
    if (this.#current !== undefined) {
      throw new Error(`Store "${this.storeName}" has change set "${this.#current.changeSetId}" open`);
    }
    this.#current = { changeSetId, staging: this.#buildStaging() };
  }

  /**
   * Commits the change set's staged data: flushes it via {@link flushStaged}, then closes the change set. Runs
   * inside the transaction owned by the caller.
   *
   * Not meant to be overridden: subclasses implement {@link flushStaged}.
   *
   * @throws If the change set is not open.
   */
  async commitStaged(changeSetId: ChangeSetId): Promise<void> {
    const current = this.#currentOrThrow(changeSetId);
    await this.flushStaged(current.staging, this.#db);
    this.#closeChangeSet(changeSetId);
  }

  /** Closes the change set, discarding any staged data without committing. A no-op if it is not open. */
  discardStaged(changeSetId: ChangeSetId): Promise<void> {
    this.#closeChangeSet(changeSetId);
    return Promise.resolve();
  }

  /**
   * Rolls the store back to `toBlock` via {@link applyRollback}.
   *
   * Must be called inside a transaction owned by the caller, since it opens none of its own.
   *
   * Not meant to be overridden: subclasses implement {@link applyRollback}.
   *
   * @throws If a change set is open, since its staged writes could later be committed anchored to deleted blocks.
   */
  async rollbackToBlock(toBlock: number): Promise<void> {
    if (this.#current !== undefined) {
      throw new Error(
        `Store "${this.storeName}": cannot roll back while change set "${this.#current.changeSetId}" is open`,
      );
    }
    await this.applyRollback(toBlock, this.#db);
  }

  /**
   * Writes the change set's staged data to persistent storage. Runs inside the caller's transaction: it must not
   * open a transaction of its own or take the store's lock.
   */
  protected abstract flushStaged(staging: TStaging, db: TDb): Promise<void>;

  /**
   * Deletes the state originating from blocks strictly above `toBlock`. Runs inside the transaction owned by
   * {@link rollbackToBlock}'s caller: it must not open a transaction of its own or take the store's lock.
   */
  protected abstract applyRollback(toBlock: number, db: TDb): Promise<void>;

  /**
   * Runs a change set operation (read or write). Takes the store's lock, opens a transaction, and calls `fn` with the
   * change set's staged data and a read-only view of the DB (writes are staged in memory until {@link flushStaged}
   * runs on commit).
   *
   * The lock serializes the change set's operations: staged data lives in JS memory, outside the DB transaction's
   * isolation, so two operations interleaving across awaits could lose an update.
   *
   * @throws If the change set is not open.
   */
  protected async withStaging<R>(
    changeSetId: ChangeSetId,
    fn: (staging: TStaging, db: ReadonlyDb<TDb>) => Promise<R>,
  ): Promise<R> {
    this.#currentOrThrow(changeSetId);
    await this.#lock.acquire();
    try {
      return await this.#store.transactionAsync(() => {
        // Re-resolve after the wait: the change set may have ended while this operation queued on the lock.
        const current = this.#currentOrThrow(changeSetId);
        return fn(current.staging, this.#db);
      });
    } finally {
      this.#lock.release();
    }
  }

  #currentOrThrow(changeSetId: ChangeSetId): OpenChangeSet<TStaging> {
    if (this.#current?.changeSetId !== changeSetId) {
      throw new Error(`Store "${this.storeName}": change set "${changeSetId}" is not open`);
    }
    return this.#current;
  }

  #closeChangeSet(changeSetId: ChangeSetId): void {
    if (this.#current?.changeSetId === changeSetId) {
      this.#current = undefined;
    }
  }
}

/**
 * View of a store's kv handles restricted to the kv interfaces' read methods. Change set operations receive this view:
 * while a change set is open the DB is read-only, since all writes are staged in memory until
 * {@link BaseStagingStore.flushStaged} runs on commit.
 */
export type ReadonlyDb<T> = {
  readonly [K in keyof T]: Pick<T[K], Extract<keyof T[K], ReadMethod>>;
};

/** The kv read surface staging stores use: what {@link ReadonlyDb} exposes while a change set is open. */
type ReadMethod =
  | 'getAsync'
  | 'hasAsync'
  | 'entriesAsync'
  | 'valuesAsync'
  | 'keysAsync'
  | 'sizeAsync'
  | 'getValuesAsync'
  | 'getValueCountAsync';

/** The change set in progress: its id and its staged data, created empty when the change set opens. */
type OpenChangeSet<T> = { changeSetId: ChangeSetId; staging: T };
