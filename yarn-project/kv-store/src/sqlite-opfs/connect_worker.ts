import type { WorkerResponse } from './messages.js';
import type { ConnectSqliteWorkerPort } from './store.js';

/** Starts the OPFS worker that runs the browser store's requests, and routes its replies to the store. */
export const connectSqliteWorker: ConnectSqliteWorkerPort = (onResponse, onCrash) => {
  // @dependency ./worker.ts
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => onResponse(ev.data);
  worker.onerror = ev => onCrash(ev.message);
  return worker;
};
