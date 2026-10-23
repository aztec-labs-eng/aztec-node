// Test helper: rewrites every row of a closed store through the store's own pool VFS, then hangs once part of the
// commit has reached the database file, so the test can kill the worker mid-commit.
import sqlite3InitModule from '@aztec-labs/sqlite3mc-wasm';

self.onmessage = async ({ data: { directory, dbPath, hangAfter } }) => {
  const sqlite3 = await sqlite3InitModule();
  const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'aztec-kv-opfs', directory });
  const db = new pool.OpfsSAHPoolDb(dbPath);
  // A small page cache spills pages to the database file before COMMIT.
  db.exec('PRAGMA cache_size = 8');
  let rows = 0;
  db.createFunction('tick', () => {
    if (++rows === hangAfter) {
      self.postMessage('hanging');
      for (;;) {
        // Spin until the test terminates this worker.
      }
    }
    return 1;
  });
  db.exec(`UPDATE data SET value = randomblob(600), hash = hex(randomblob(16)) WHERE tick()`);
};
