import { MAX_TX_SIZE_KB } from '@aztec-labs/stdlib/p2p';
import { TxHash, TxHashArray } from '@aztec-labs/stdlib/tx';
import { describe, expect, it } from '@jest/globals';
import type { PeerId } from '@libp2p/interface';
import { mock, mockDeep } from 'jest-mock-extended';

import type { MemPools } from '../../../mem_pools/interface.js';
import { calculateTxResponseSize, reqRespTxHandler } from './tx.js';

describe('calculateTxResponseSize', () => {
  it('should return correct size for a single tx hash', () => {
    const hashes = new TxHashArray(TxHash.random());
    const buffer = hashes.toBuffer();

    expect(calculateTxResponseSize(buffer)).toBe(MAX_TX_SIZE_KB + 1);
  });

  it('should return correct size for multiple tx hashes', () => {
    const hashes = new TxHashArray(TxHash.random(), TxHash.random(), TxHash.random());
    const buffer = hashes.toBuffer();

    expect(calculateTxResponseSize(buffer)).toBe(3 * MAX_TX_SIZE_KB + 1);
  });

  it('should return correct size for 8 tx hashes (default batch size)', () => {
    const hashes = new TxHashArray(...Array.from({ length: 8 }, () => TxHash.random()));
    const buffer = hashes.toBuffer();

    expect(calculateTxResponseSize(buffer)).toBe(8 * MAX_TX_SIZE_KB + 1);
  });

  it('should fall back to single tx size for a raw TxHash buffer (not TxHashArray)', () => {
    // A raw TxHash (32 bytes) is not a valid TxHashArray serialization.
    // TxHashArray.fromBuffer silently returns empty array on parse failure.
    const rawHash = TxHash.random().toBuffer();

    expect(calculateTxResponseSize(rawHash)).toBe(MAX_TX_SIZE_KB + 1);
  });

  it('should fall back to single tx size for garbage buffer', () => {
    const garbage = Buffer.from('not a valid buffer');

    expect(calculateTxResponseSize(garbage)).toBe(MAX_TX_SIZE_KB + 1);
  });

  it('should return at least single tx size for empty TxHashArray', () => {
    const hashes = new TxHashArray();
    const buffer = hashes.toBuffer();

    // Empty TxHashArray serializes to a valid buffer with length prefix 0
    // We expect at least 1 * MAX_TX_SIZE_KB + 1
    expect(calculateTxResponseSize(buffer)).toBe(MAX_TX_SIZE_KB + 1);
  });
});

describe('reqRespTxHandler', () => {
  const peerId = mock<PeerId>();

  const makeMempools = (getTxByHash: (h: TxHash) => Promise<undefined>): MemPools => {
    const mempools = mockDeep<MemPools>();
    mempools.txPool.getTxByHash.mockImplementation(getTxByHash);
    return mempools;
  };

  it('serves a repeated hash only once (de-duplicates before pool reads)', async () => {
    const h = TxHash.random();
    const lookups: string[] = [];
    const mempools = makeMempools(async (x: TxHash) => {
      lookups.push(x.toString());
      return undefined;
    });
    const request = new TxHashArray(h, h, h, h, h).toBuffer();

    await reqRespTxHandler(mempools)(peerId, request);

    // One repeated hash must cause exactly one pool read, not one per copy.
    expect(lookups).toEqual([h.toString()]);
  });

  it('still serves each distinct hash in a normal batch', async () => {
    const hashes = Array.from({ length: 3 }, () => TxHash.random());
    const lookups: string[] = [];
    const mempools = makeMempools(async (x: TxHash) => {
      lookups.push(x.toString());
      return undefined;
    });
    const request = new TxHashArray(...hashes).toBuffer();

    await reqRespTxHandler(mempools)(peerId, request);

    expect(lookups.sort()).toEqual(hashes.map(h => h.toString()).sort());
  });

  it('rejects a request with too many hashes', async () => {
    const lookups: string[] = [];
    const mempools = makeMempools(async (x: TxHash) => {
      lookups.push(x.toString());
      return undefined;
    });
    const request = new TxHashArray(...Array.from({ length: 101 }, () => TxHash.random())).toBuffer();

    await expect(reqRespTxHandler(mempools)(peerId, request)).rejects.toThrow();
    // Over-cap request is rejected before any pool read.
    expect(lookups).toHaveLength(0);
  });
});
