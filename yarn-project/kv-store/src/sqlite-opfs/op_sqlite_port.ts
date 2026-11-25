// eslint-disable-next-line import-x/no-extraneous-dependencies -- an optional peer dependency: the app provides it
import { type DB, type Scalar, open as openOpSqlite } from '@op-engineering/op-sqlite';

import { detectEncryptionCode } from './errors.js';
import type { SqlValue, WorkerRequest, WorkerResponse } from './messages.js';
import { SCHEMA_SQL } from './schema.js';
import type { SqlitePort } from './store.js';

/**
 * Runs the store's requests on op-sqlite, with the database `<location>/<name>`, or in memory when `location` is
 * `:memory:`. `onTerminate` runs when the store stops the port.
 */
export function connectOpSqlite(location: string, onTerminate: () => void): SqlitePort {
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
        if (location === ':memory:') {
          closeDb();
        } else {
          requireDb().delete();
          db = undefined;
        }
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
    request: async req => {
      try {
        return await handle(req);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (req.type === 'init') {
          try {
            closeDb();
          } catch {
            // The store terminates the port after a failed init.
          }
        }
        return { type: 'err', id: req.id, message, encryptionCode: detectEncryptionCode(req, err, message) };
      }
    },
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
