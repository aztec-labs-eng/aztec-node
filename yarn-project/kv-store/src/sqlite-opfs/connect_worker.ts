import type { Logger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';

import type { WorkerResponse } from './messages.js';
import type { SqlitePort } from './store.js';

/** Starts the OPFS worker that runs the browser store's requests, and matches its replies to the requests by id. */
export function connectSqliteWorker(log: Logger): SqlitePort {
  // @dependency ./worker.ts
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: (resp: WorkerResponse) => void; reject: (err: Error) => void }>();
  let crashed = false;
  const rejectPending = (err: Error) => {
    for (const { reject } of pending.values()) {
      reject(err);
    }
    pending.clear();
  };

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const handler = pending.get(ev.data.id);
    if (!handler) {
      log.warn(`SQLite worker: no pending handler for id ${ev.data.id}`);
      return;
    }
    pending.delete(ev.data.id);
    handler.resolve(ev.data);
  };
  worker.onerror = ev => {
    crashed = true;
    log.error(`SQLite worker crashed: ${ev.message}`);
    rejectPending(new Error(`SQLite worker crashed: ${ev.message}`));
  };

  return {
    request: (req, transfer = []) => {
      if (crashed) {
        return Promise.reject(new Error('SQLite worker has crashed'));
      }
      const { promise, resolve, reject } = promiseWithResolvers<WorkerResponse>();
      pending.set(req.id, { resolve, reject });
      worker.postMessage(req, transfer);
      return promise;
    },
    terminate: () => {
      worker.terminate();
      rejectPending(new Error('SQLite worker terminated'));
    },
  };
}
