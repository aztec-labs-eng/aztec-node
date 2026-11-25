/**
 * React Native has no OPFS worker: its store runs on op-sqlite. This stands in for the browser's module, whose
 * `import.meta` Metro does not parse.
 */
export function createSqliteWorker(): Worker {
  throw new Error('The OPFS worker does not run on React Native');
}
