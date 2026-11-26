import type { Logger } from '@aztec-labs/foundation/log';

import type { SqlitePort } from './store.js';

/**
 * React Native has no OPFS worker: its store runs on op-sqlite. This stands in for the browser's module, whose
 * `import.meta` Metro does not parse.
 */
export function connectSqliteWorker(_log: Logger): SqlitePort {
  throw new Error('The OPFS worker does not run on React Native');
}
