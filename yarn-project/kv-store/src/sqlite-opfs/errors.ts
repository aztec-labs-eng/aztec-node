export {
  SqliteCorruptionError,
  SqliteEncryptionError,
  type SqliteEncryptionErrorCode,
  isCorruptionMessage,
  isDecryptFailureMessage,
} from '../kv-sqlite/errors.js';

/** Error thrown when another browser context already owns a store's OPFS pool. */
export class SqlitePoolBusyError extends Error {
  constructor(public readonly poolDirectory: string) {
    super(`SQLite-OPFS pool "${poolDirectory}" is already in use by another store instance`);
    this.name = 'SqlitePoolBusyError';
  }
}

/** Error thrown when the browser context does not expose the Web Locks API required by the OPFS SAH pool. */
export class SqliteWebLocksUnavailableError extends Error {
  constructor() {
    super('SQLite-OPFS requires the Web Locks API, but it is unavailable in this browser context');
    this.name = 'SqliteWebLocksUnavailableError';
  }
}
