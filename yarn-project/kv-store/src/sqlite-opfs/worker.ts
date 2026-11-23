/// <reference lib="webworker" />
import { SyncApi, createBackendSync } from '@aztec-labs/kv-sqlite';
import { handleRequestSync } from '@aztec-labs/kv-sqlite-files';

import type { WorkerRequest, WorkerResponse } from './messages.js';
import { OpfsSahPoolFiles } from './opfs_files.js';

// The Kv service's wasm module on this worker's thread, its files kept in the OPFS pool through sync access handles
// (only a dedicated worker has them), so each command runs to completion before the next message is taken.
let service: Awaited<ReturnType<typeof createBackendSync>> | undefined;
let pool: OpfsSahPoolFiles | undefined;

async function open(path: string | undefined, poolDirectory: string | undefined, encryptionKey?: Uint8Array) {
  if (service) {
    throw new Error('SQLite worker: a store is already open');
  }
  try {
    const files = poolDirectory ? (pool = await OpfsSahPoolFiles.open(poolDirectory)) : undefined;
    service = await createBackendSync({
      backend: 'wasm',
      wasm: files ? { hostCall: { files: request => handleRequestSync(files, request) } } : {},
    });
    new SyncApi(service).init({ path: path ?? null, encryptionKey: encryptionKey ?? null });
  } catch (err) {
    close();
    throw err;
  } finally {
    encryptionKey?.fill(0);
  }
}

/**
 * Ends the service and releases the pool's sync access handles before the request is acked. Worker termination
 * releases them only asynchronously, so without this a caller that deletes or reopens the store directory right after
 * close()/delete() resolves races Chromium's cleanup (NoModificationAllowedError from removeEntry, or a hang opening
 * the pool again).
 */
function close() {
  try {
    service?.destroy();
  } finally {
    service = undefined;
    pool?.release();
    pool = undefined;
  }
}

function respond(msg: WorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg, transfer);
}

(self as DedicatedWorkerGlobalScope).onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    switch (req.type) {
      case 'open':
        await open(req.path, req.poolDirectory, req.encryptionKey);
        return respond({ type: 'ok', id: req.id });
      case 'call': {
        if (!service) {
          throw new Error('SQLite worker: no store open');
        }
        // A copy: the answer may be a view of the module's memory, which must not be transferred away.
        const bytes = service.call(req.bytes).slice();
        return respond({ type: 'ok', id: req.id, bytes }, [bytes.buffer as ArrayBuffer]);
      }
      case 'close':
        close();
        return respond({ type: 'ok', id: req.id });
      default: {
        const _exhaustive: never = req;
        throw new Error(`Unknown request: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    respond({ type: 'err', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
