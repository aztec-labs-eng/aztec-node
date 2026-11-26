import { jest } from '@jest/globals';

import { promiseWithResolvers } from '../promise/utils.js';
import { getOrComputeAsync } from './get_or_compute_async.js';
import { LruMap } from './lru_map.js';

describe('getOrComputeAsync', () => {
  let cache: Map<string, Promise<number>>;

  beforeEach(() => {
    cache = new Map();
  });

  it('shares one computation between concurrent and later callers', async () => {
    const pending = promiseWithResolvers<number>();
    const compute = jest.fn(() => pending.promise);

    const first = getOrComputeAsync(cache, 'a', compute);
    const concurrent = getOrComputeAsync(cache, 'a', compute);
    pending.resolve(1);

    await expect(first).resolves.toBe(1);
    await expect(concurrent).resolves.toBe(1);
    await expect(getOrComputeAsync(cache, 'a', compute)).resolves.toBe(1);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('keeps the computations of different keys apart', async () => {
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(1))).resolves.toBe(1);
    await expect(getOrComputeAsync(cache, 'b', () => Promise.resolve(2))).resolves.toBe(2);
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(3))).resolves.toBe(1);
  });

  it('keeps an undefined result', async () => {
    const undefinedCache = new Map<string, Promise<undefined>>();
    const compute = jest.fn(() => Promise.resolve(undefined));

    await getOrComputeAsync(undefinedCache, 'a', compute);
    await getOrComputeAsync(undefinedCache, 'a', compute);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('rejects every waiting caller of a failed computation, and computes again on the next call', async () => {
    const pending = promiseWithResolvers<number>();
    const first = getOrComputeAsync(cache, 'a', () => pending.promise);
    const concurrent = getOrComputeAsync(cache, 'a', () => Promise.resolve(2));
    pending.reject(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    await expect(concurrent).rejects.toThrow('boom');
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(3))).resolves.toBe(3);
  });

  it('reports a compute that throws synchronously as a rejection, and does not cache it', async () => {
    const throwing = () => {
      throw new Error('sync boom');
    };

    let result: Promise<number> | undefined;
    expect(() => (result = getOrComputeAsync(cache, 'a', throwing))).not.toThrow();
    await expect(result).rejects.toThrow('sync boom');
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(2))).resolves.toBe(2);
  });

  it('shares a value that shouldCache turns away with the callers already waiting, then computes again', async () => {
    const pending = promiseWithResolvers<number>();
    const shouldCache = (value: number) => value !== 1;
    const first = getOrComputeAsync(cache, 'a', () => pending.promise, { shouldCache });
    const concurrent = getOrComputeAsync(cache, 'a', () => Promise.resolve(2), { shouldCache });
    pending.resolve(1);

    await expect(first).resolves.toBe(1);
    await expect(concurrent).resolves.toBe(1);
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(3), { shouldCache })).resolves.toBe(3);
  });

  it('rejects the callers when shouldCache throws, and computes again on the very next call', async () => {
    const shouldCache = () => {
      throw new Error('predicate boom');
    };

    // Plain awaits leave no microtask between the failed call and the retry, so the entry must already be gone when
    // the first caller resumes.
    let error: unknown;
    try {
      await getOrComputeAsync(cache, 'a', () => Promise.resolve(1), { shouldCache });
    } catch (err) {
      error = err;
    }
    const retry = await getOrComputeAsync(cache, 'a', () => Promise.resolve(2));

    expect(error).toEqual(new Error('predicate boom'));
    expect(retry).toBe(2);
  });

  it('does not remove a newer entry when an older computation of the same key fails', async () => {
    const older = promiseWithResolvers<number>();
    const olderResult = getOrComputeAsync(cache, 'a', () => older.promise);
    cache.delete('a');
    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(2))).resolves.toBe(2);

    older.reject(new Error('boom'));
    await expect(olderResult).rejects.toThrow('boom');

    await expect(getOrComputeAsync(cache, 'a', () => Promise.resolve(3))).resolves.toBe(2);
  });

  it('computes again a key that a bounded cache evicted', async () => {
    const bounded = new LruMap<string, Promise<number>>(1);
    await getOrComputeAsync(bounded, 'a', () => Promise.resolve(1));
    await getOrComputeAsync(bounded, 'b', () => Promise.resolve(2));

    await expect(getOrComputeAsync(bounded, 'a', () => Promise.resolve(3))).resolves.toBe(3);
    expect(bounded.size).toBe(1);
  });
});
