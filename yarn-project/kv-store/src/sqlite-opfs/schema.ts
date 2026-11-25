/** The store's one table and its indexes, created when a database opens. Every container is rows of it. */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS data (
    slot TEXT NOT NULL PRIMARY KEY,
    container TEXT NOT NULL,
    key BLOB NOT NULL,
    key_count INTEGER NOT NULL,
    hash TEXT NOT NULL,
    value BLOB
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_container_key ON data(container, key);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_container_key_count ON data(container, key, key_count);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_container_key_hash ON data(container, key, hash);
`;
