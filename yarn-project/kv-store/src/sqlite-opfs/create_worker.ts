/** Starts the OPFS worker that the browser's store runs its requests on. */
export function createSqliteWorker(): Worker {
  // @dependency ./worker.ts
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}
