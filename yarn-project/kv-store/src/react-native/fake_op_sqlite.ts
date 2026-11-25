import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { join } from 'path';

/**
 * The part of op-sqlite that the React Native store uses, over node:sqlite. node:sqlite has no SQLCipher: the fake keeps
 * a database's key beside it and fails a wrong or missing key as SQLCipher does, on the first statement.
 */
export function open({ name, location, encryptionKey }: { name: string; location: string; encryptionKey?: string }) {
  const path = location === ':memory:' ? location : join(location, name);
  const keyPath = `${path}.key`;
  if (path !== ':memory:') {
    mkdirSync(location, { recursive: true });
    if (encryptionKey && !existsSync(path)) {
      writeFileSync(keyPath, encryptionKey);
    }
  }
  const storedKey = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : undefined;
  const db = new DatabaseSync(path);
  return {
    executeRaw: (sql: string, params: SQLInputValue[] = []) => {
      if (storedKey !== encryptionKey) {
        return Promise.reject(new Error('file is not a database'));
      }
      if (params.length === 0 && sql.includes(';')) {
        db.exec(sql);
        return Promise.resolve({ rowsAffected: 0, rawRows: [] });
      }
      // op-sqlite returns blobs as ArrayBuffers.
      const rows = db
        .prepare(sql)
        .all(...params)
        .map(row => Object.values(row).map(value => (value instanceof Uint8Array ? value.slice().buffer : value)));
      const { changes } = db.prepare('SELECT changes() AS changes').get() as { changes: number };
      return Promise.resolve({ rowsAffected: changes, rawRows: rows });
    },
    close: () => db.close(),
    delete: () => {
      db.close();
      rmSync(path, { force: true });
      rmSync(keyPath, { force: true });
    },
  };
}
