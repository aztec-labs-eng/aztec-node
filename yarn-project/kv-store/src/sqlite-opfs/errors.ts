import type { WorkerRequest } from './messages.js';

/**
 * Typed error surface for sqlite3mc-backed page-level encryption failures.
 *
 * Three concrete failure modes are surfaced:
 *
 *   - `invalid_key_length`: caller-side pre-flight (key not 32 bytes).
 *   - `encryption_not_supported_for_ephemeral`: caller-side pre-flight (encryption was requested on an ephemeral
 *     `:memory:` store, which sqlite3mc does not support).
 *   - `decrypt_failed`: runtime failure raised when sqlite3mc cannot decode page 1 of an existing database. Covers
 *     both "wrong key supplied" and "no key supplied to an encrypted DB".
 */
export type SqliteEncryptionErrorCode =
  | 'invalid_key_length'
  | 'encryption_not_supported_for_ephemeral'
  | 'decrypt_failed';

/**
 * Error thrown by sqlite-opfs when an encryption operation fails.
 **/
export class SqliteEncryptionError extends Error {
  readonly code: SqliteEncryptionErrorCode;

  constructor(code: SqliteEncryptionErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SqliteEncryptionError';
    this.code = code;
  }
}

/**
 * Strings raised by sqlite3mc when page 1 cannot be decoded.
 **/
const SQLITE3MC_DECRYPT_ERROR_PATTERNS: readonly RegExp[] = [
  /file is not a database/i,
  /file is encrypted or is not a database/i,
];

/**
 * Returns `true` if `message` matches one of the known sqlite3mc decrypt-failure
 * strings.
 **/
export function isDecryptFailureMessage(message: string): boolean {
  return SQLITE3MC_DECRYPT_ERROR_PATTERNS.some(p => p.test(message));
}

/**
 * Error thrown by sqlite-opfs when the on-disk database image is corrupt
 * (`SQLITE_CORRUPT`, result code 11 — "database disk image is malformed").
 *
 * Distinct from {@link SqliteEncryptionError}: no key recovers a corrupt image,
 * so there is nothing to retry. The only escape is to delete the store and start
 * fresh, so consumers pattern-match on `instanceof SqliteCorruptionError` to wipe
 * and reopen rather than surfacing a dead-end error.
 **/
export class SqliteCorruptionError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SqliteCorruptionError';
  }
}

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

/**
 * Strings/codes raised by SQLite when a database image is corrupt. Kept disjoint
 * from {@link SQLITE3MC_DECRYPT_ERROR_PATTERNS}: "file is not a database"
 * (SQLITE_NOTADB) is the decrypt signal, whereas a malformed image is the
 * genuinely-unrecoverable SQLITE_CORRUPT.
 **/
const SQLITE_CORRUPTION_ERROR_PATTERNS: readonly RegExp[] = [
  /database disk image is malformed/i,
  /\bSQLITE_CORRUPT\b/i,
];

/**
 * Returns `true` if `message` matches one of the known SQLite corruption strings.
 **/
export function isCorruptionMessage(message: string): boolean {
  return SQLITE_CORRUPTION_ERROR_PATTERNS.some(p => p.test(message));
}

/**
 * Maps a thrown error during request handling to a typed encryption code, so the
 * main thread can re-hydrate it as a {@link SqliteEncryptionError}. Returns
 * `undefined` for non-encryption errors (preserves the existing untyped path).
 *
 * Two sources:
 *   - The error was already a `SqliteEncryptionError` (pre-flight throws inside
 *     this worker — e.g. ephemeral + encryptionKey). Forward its code as-is.
 *   - The error came from SQLite/sqlite3mc with a known decrypt-failure message
 *     during an `init` request. Both "wrong key supplied" and "no key supplied
 *     to an encrypted DB" surface as SQLITE_NOTADB ("file is not a database") —
 *     we don't constrain on `req.encryptionKey` because the no-key-on-encrypted-DB
 *     case is exactly when the caller most needs the typed signal.
 */
export function detectEncryptionCode(
  req: WorkerRequest,
  err: unknown,
  message: string,
): SqliteEncryptionErrorCode | undefined {
  if (err instanceof SqliteEncryptionError) {
    return err.code;
  }
  if (req.type === 'init' && isDecryptFailureMessage(message)) {
    return 'decrypt_failed';
  }
  return undefined;
}
