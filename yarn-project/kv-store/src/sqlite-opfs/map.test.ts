import { Buffer } from 'buffer';
import { type MockInstance, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { describeAztecMap } from '../interfaces/map_test_suite.js';
import { mockLogger } from '../interfaces/utils.js';
import type { WorkerRequest } from './messages.js';
import { AztecSQLiteOPFSStore } from './store.js';

/**
 * Far larger than the encoder's initial 8 KiB output buffer, so that packing a value this size grows the buffer that
 * later small values are written into.
 */
const LARGE_VALUE_SIZE_IN_BYTES = 4 * 1024 * 1024;

describe('SQLiteOPFSMap', () => {
  describeAztecMap('AztecMap', async () => await AztecSQLiteOPFSStore.open(mockLogger, undefined, true));

  describe('requests to the worker', () => {
    let store: AztecSQLiteOPFSStore;
    let postMessage: MockInstance<Worker['postMessage']>;

    beforeEach(async () => {
      store = await AztecSQLiteOPFSStore.open(mockLogger, undefined, true);
      postMessage = vi.spyOn(Worker.prototype, 'postMessage');
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await store.delete();
    });

    const expectOnlyExactSizeBytesPosted = () => {
      const requests: WorkerRequest[] = postMessage.mock.calls.map(([request]) => request);
      const boundBytes = requests
        .flatMap(request => ('bind' in request ? (request.bind ?? []) : []))
        .filter(value => value instanceof Uint8Array);
      expect(boundBytes).not.toHaveLength(0);
      expect(boundBytes.map(bytes => bytes.buffer.byteLength)).toEqual(boundBytes.map(bytes => bytes.byteLength));
    };

    it('sends only the bytes of each value a map writes', async () => {
      const map = store.openMap<string, Buffer>('values');
      await map.set('large', Buffer.alloc(LARGE_VALUE_SIZE_IN_BYTES));
      await map.set('small', Buffer.from([1, 2, 3]));

      expectOnlyExactSizeBytesPosted();
      expect(await map.getAsync('small')).toEqual(Buffer.from([1, 2, 3]));
    });

    it('sends only the bytes of a byte array bound to a query', async () => {
      const backing = new Uint8Array(1024);
      backing.set([1, 2, 3], 8);

      const rows = await store.allAsync('SELECT ?', [backing.subarray(8, 11)]);

      expectOnlyExactSizeBytesPosted();
      expect(rows).toEqual([[new Uint8Array([1, 2, 3])]]);
    });
  });
});
