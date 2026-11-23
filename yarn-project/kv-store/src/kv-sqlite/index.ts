import { createLogger } from '@aztec-labs/foundation/log';

import { AztecKvSqliteStore } from './store.js';

export { AztecKvSqliteStore, type KvClient, type KvSqliteStoreOptions } from './store.js';
export { SqliteCorruptionError, SqliteEncryptionError, type SqliteEncryptionErrorCode } from './errors.js';

/** An ephemeral store, in memory, on the platform's default Kv backend. */
export function openTmpStore(): Promise<AztecKvSqliteStore> {
  return AztecKvSqliteStore.create(createLogger('kv-store:kv-sqlite'));
}
