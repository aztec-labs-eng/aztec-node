import { randomBytes } from '@aztec/foundation/crypto/random';
import { type Logger, type LoggerBindings, createLogger } from '@aztec/foundation/log';
import type { AztecAsyncKVStore } from '@aztec/kv-store';

/**
 * Identifies one change set: the writes staged together between a `begin` and its matching commit or abort.
 */
export type ChangeSetId = string;

/**
 * Interface that stores must implement to support staged writes.
 */
export interface StagedStore {
  /** Unique name identifying this store (used for tracking staged stores from StagedWriteCoordinator) */
  readonly storeName: string;

  /**
   * Commits staged data to main storage. Should be called within a transaction for atomicity.
   *
   * @param changeSetId - The change set identifier
   */
  commitStaged(changeSetId: ChangeSetId): Promise<void>;

  /**
   * Discards staged data without committing. Called on abort.
   *
   * @param changeSetId - The change set identifier
   */
  discardStaged(changeSetId: ChangeSetId): Promise<void>;
}

/**
 * StagedWriteCoordinator simulates a database transaction across the PXE stores, which the underlying KV store
 * (e.g. IndexedDB) cannot provide on its own for long-running async operations. It also provides crash resilience:
 * staged data that was never committed is simply never promoted to main storage.
 *
 * It uses a staged writes pattern:
 * 1. When a change set is opened, a unique ID is created
 * 2. While a change set is open, all writes are staged under its ID, and reads observe the staged data
 * 3. On commit, the staged data is promoted to main storage
 * 4. On abort, staged data is discarded
 *
 * Note: change sets must be serialized — {@link begin} throws if one is already open. We still key staged data by
 * change set ID because aborting doesn't cancel in-flight async work: a late write from an aborted change set lands
 * under its old ID and is never promoted, instead of leaking into the next change set.
 */
export class StagedWriteCoordinator {
  readonly #kvStore: AztecAsyncKVStore;
  readonly #stores: Map<string, StagedStore> = new Map();
  readonly #log: Logger;

  #currentChangeSetId: ChangeSetId | undefined;

  constructor(args: StagedWriteCoordinatorArgs) {
    this.#kvStore = args.kvStore;
    this.#log = createLogger('pxe:staged_write_coordinator', args.bindings);
    for (const store of args.stores) {
      if (this.#stores.has(store.storeName)) {
        throw new Error(`Store "${store.storeName}" is already registered`);
      }
      this.#stores.set(store.storeName, store);
    }
  }

  /**
   * Opens a change set and returns its ID for staged writes.
   *
   * @returns Change set ID to pass to store operations
   */
  begin(): ChangeSetId {
    if (this.#currentChangeSetId) {
      throw new Error(
        `Cannot open change set: change set ${this.#currentChangeSetId} is already active. ` +
          `This should not happen - ensure change sets are properly committed or aborted.`,
      );
    }

    const changeSetId = randomBytes(8).toString('hex');
    this.#currentChangeSetId = changeSetId;

    this.#log.debug(`Opened change set ${changeSetId}`, { changeSetId });
    return changeSetId;
  }

  /**
   * Commits by promoting all staged data to main storage.
   *
   * @param changeSetId - The change set ID returned from begin
   */
  async commit(changeSetId: ChangeSetId): Promise<void> {
    if (this.#currentChangeSetId !== changeSetId) {
      throw new Error(
        `Cannot commit change set ${changeSetId}: no matching change set active. ` +
          `Current change set: ${this.#currentChangeSetId ?? 'none'}`,
      );
    }

    this.#log.debug(`Committing change set ${changeSetId}`, { changeSetId });

    // Commit all stores atomically in a single transaction.
    // Each store's commit is a no-op if it has no staged data (but that's up to each store to handle).
    await this.#kvStore.transactionAsync(async () => {
      for (const store of this.#stores.values()) {
        await store.commitStaged(changeSetId);
      }
    });

    this.#currentChangeSetId = undefined;
    this.#log.debug(`Change set ${changeSetId} committed successfully`, { changeSetId });
  }

  /**
   * Aborts by discarding all staged data.
   *
   * @param changeSetId - The change set ID returned from begin
   */
  async abort(changeSetId: ChangeSetId): Promise<void> {
    if (this.#currentChangeSetId !== changeSetId) {
      throw new Error(
        `Cannot abort change set ${changeSetId}: no matching change set active. ` +
          `Current change set: ${this.#currentChangeSetId ?? 'none'}`,
      );
    }

    this.#log.debug(`Aborting change set ${changeSetId}`, { changeSetId });

    for (const store of this.#stores.values()) {
      await store.discardStaged(changeSetId);
    }

    this.#currentChangeSetId = undefined;
    this.#log.debug(`Change set ${changeSetId} aborted`, { changeSetId });
  }
}

/** Dependencies of the {@link StagedWriteCoordinator}. */
type StagedWriteCoordinatorArgs = {
  kvStore: AztecAsyncKVStore;
  stores: StagedStore[];
  bindings?: LoggerBindings;
};
