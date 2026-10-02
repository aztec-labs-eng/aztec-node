import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import { mockTx } from '@aztec-labs/stdlib/testing';
import type { Tx, TxValidationResult } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';

import { TxValidationCache } from './tx_validation_cache.js';

describe('TxValidationCache', () => {
  const validatorA = Symbol('validatorA');
  const validatorB = Symbol('validatorB');

  let cache: TxValidationCache;
  let tx: Tx;

  beforeEach(async () => {
    cache = new TxValidationCache(100);
    tx = await mockTx(1);
  });

  // A call's promise is only registered after getOrValidate computes its key and calls set. This waits
  // until a call has been registered before issuing a follow-up, making coalescing assertions deterministic.
  const waitUntilCached = async (validatorSymbol: symbol, forTx: Tx) => {
    const key = cache.key(validatorSymbol, forTx);
    while (cache.get(key) === undefined) {
      await sleep(1);
    }
  };

  describe('get / set', () => {
    it('returns undefined on a cache miss', () => {
      expect(cache.get(cache.key(validatorA, tx))).toBeUndefined();
    });

    it('returns the stored promise on a cache hit', async () => {
      const result: TxValidationResult = { result: 'valid' };
      cache.set(cache.key(validatorA, tx), Promise.resolve(result));

      await expect(cache.get(cache.key(validatorA, tx))).resolves.toEqual(result);
    });

    it('does not share entries across different validator symbols', () => {
      cache.set(cache.key(validatorA, tx), Promise.resolve({ result: 'valid' }));

      expect(cache.get(cache.key(validatorB, tx))).toBeUndefined();
    });

    it('does not share entries across different txs', async () => {
      const otherTx = await mockTx(2);
      cache.set(cache.key(validatorA, tx), Promise.resolve({ result: 'valid' }));

      expect(cache.get(cache.key(validatorA, otherTx))).toBeUndefined();
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used entry when the cache is full', async () => {
      const smallCache = new TxValidationCache(2);
      const tx1 = await mockTx(10);
      const tx2 = await mockTx(11);
      const tx3 = await mockTx(12);
      const result: TxValidationResult = { result: 'valid' };

      smallCache.set(smallCache.key(validatorA, tx1), Promise.resolve(result));
      smallCache.set(smallCache.key(validatorA, tx2), Promise.resolve(result));
      // tx1 is now the LRU entry; adding tx3 should evict it
      smallCache.set(smallCache.key(validatorA, tx3), Promise.resolve(result));

      expect(smallCache.get(smallCache.key(validatorA, tx1))).toBeUndefined();
      expect(smallCache.get(smallCache.key(validatorA, tx2))).toBeDefined();
      expect(smallCache.get(smallCache.key(validatorA, tx3))).toBeDefined();
    });

    it('refreshes recency on get so that accessed entries are not evicted first', async () => {
      const smallCache = new TxValidationCache(2);
      const tx1 = await mockTx(20);
      const tx2 = await mockTx(21);
      const tx3 = await mockTx(22);
      const result: TxValidationResult = { result: 'valid' };

      smallCache.set(smallCache.key(validatorA, tx1), Promise.resolve(result));
      smallCache.set(smallCache.key(validatorA, tx2), Promise.resolve(result));
      // Access tx1 so tx2 becomes the LRU entry
      void smallCache.get(smallCache.key(validatorA, tx1));
      smallCache.set(smallCache.key(validatorA, tx3), Promise.resolve(result));

      expect(smallCache.get(smallCache.key(validatorA, tx1))).toBeDefined();
      expect(smallCache.get(smallCache.key(validatorA, tx2))).toBeUndefined();
      expect(smallCache.get(smallCache.key(validatorA, tx3))).toBeDefined();
    });

    it('throws when constructed with maxSize < 1', () => {
      expect(() => new TxValidationCache(0)).toThrow();
    });
  });

  describe('getOrValidate', () => {
    it('calls validate and caches the result on a miss', async () => {
      const expected: TxValidationResult = { result: 'invalid', reason: ['bad'] };
      const validate = jest.fn<() => Promise<TxValidationResult>>().mockResolvedValue(expected);

      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual(expected);
      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('returns the cached promise on a hit without calling validate again', async () => {
      const expected: TxValidationResult = { result: 'valid' };
      const validate = jest.fn<() => Promise<TxValidationResult>>().mockResolvedValue(expected);

      await cache.getOrValidate(validatorA, tx, validate);
      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual(expected);
      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('shares an in-flight validation so concurrent calls for the same key validate once', async () => {
      const expected: TxValidationResult = { result: 'invalid', reason: ['bad proof'] };

      let resolveValidation!: (v: TxValidationResult) => void;
      const inFlight = new Promise<TxValidationResult>(resolve => {
        resolveValidation = resolve;
      });
      const validate = jest.fn<() => Promise<TxValidationResult>>().mockReturnValue(inFlight);

      const first = cache.getOrValidate(validatorA, tx, validate);
      await waitUntilCached(validatorA, tx);
      const second = cache.getOrValidate(validatorA, tx, validate);
      const third = cache.getOrValidate(validatorA, tx, validate);

      resolveValidation(expected);

      await expect(first).resolves.toEqual(expected);
      await expect(second).resolves.toEqual(expected);
      await expect(third).resolves.toEqual(expected);

      expect(validate).toHaveBeenCalledTimes(1);
    });

    it('scopes validation results by validator symbol', async () => {
      const resultA: TxValidationResult = { result: 'valid' };
      const resultB: TxValidationResult = { result: 'invalid', reason: ['nope'] };

      const validateA = jest.fn<() => Promise<TxValidationResult>>().mockResolvedValue(resultA);
      const validateB = jest.fn<() => Promise<TxValidationResult>>().mockResolvedValue(resultB);

      await expect(cache.getOrValidate(validatorA, tx, validateA)).resolves.toEqual(resultA);
      await expect(cache.getOrValidate(validatorB, tx, validateB)).resolves.toEqual(resultB);

      expect(validateA).toHaveBeenCalledTimes(1);
      expect(validateB).toHaveBeenCalledTimes(1);
    });

    it('keeps an invalid verdict', async () => {
      const invalid: TxValidationResult = { result: 'invalid', reason: ['bad proof'] };
      const validate = jest
        .fn<() => Promise<TxValidationResult>>()
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce({ result: 'valid' });

      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual(invalid);
      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual(invalid);
    });

    it('does not keep an unverifiable result, so the next call checks the tx again', async () => {
      const unverifiable: TxValidationResult = { result: 'unverifiable', reason: ['verifier down'] };
      const validate = jest
        .fn<() => Promise<TxValidationResult>>()
        .mockResolvedValueOnce(unverifiable)
        .mockResolvedValueOnce({ result: 'valid' });

      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual(unverifiable);
      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual({ result: 'valid' });
    });

    it('does not keep a rejected validation, so the next call checks the tx again', async () => {
      const validate = jest
        .fn<() => Promise<TxValidationResult>>()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({ result: 'valid' });

      await expect(cache.getOrValidate(validatorA, tx, validate)).rejects.toThrow('temporary failure');
      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual({ result: 'valid' });
    });

    it('gives every caller waiting on an unverifiable validation its result, then forgets it', async () => {
      const unverifiable: TxValidationResult = { result: 'unverifiable', reason: ['verifier down'] };
      const { promise: inFlight, resolve } = promiseWithResolvers<TxValidationResult>();
      const validate = jest
        .fn<() => Promise<TxValidationResult>>()
        .mockReturnValueOnce(inFlight)
        .mockResolvedValueOnce({ result: 'valid' });

      const first = cache.getOrValidate(validatorA, tx, validate);
      await waitUntilCached(validatorA, tx);
      const second = cache.getOrValidate(validatorA, tx, validate);

      resolve(unverifiable);
      await expect(first).resolves.toEqual(unverifiable);
      await expect(second).resolves.toEqual(unverifiable);
      await expect(cache.getOrValidate(validatorA, tx, validate)).resolves.toEqual({ result: 'valid' });
    });

    it('does not evict an entry that replaced an unverifiable validation before it settled', async () => {
      const { promise: inFlight, reject } = promiseWithResolvers<TxValidationResult>();
      const key = cache.key(validatorA, tx);

      const first = cache.getOrValidate(validatorA, tx, () => inFlight);
      const replacement = Promise.resolve<TxValidationResult>({ result: 'valid' });
      cache.set(key, replacement);

      reject(new Error('verifier down'));
      await expect(first).rejects.toThrow('verifier down');
      expect(cache.get(key)).toBe(replacement);
    });
  });
});
