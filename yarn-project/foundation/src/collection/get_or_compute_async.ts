/**
 * Returns the promise cached for `key`, computing it if absent.
 *
 * A missing key calls `compute` and stores the promise it returns in `cache`, so that later and concurrent callers
 * share one computation.
 *
 * An entry is removed once its promise rejects, so that the next call computes again, and so is one for whose value
 * `shouldCache` returns `false`. Callers already waiting on the promise still receive its outcome. The entry is removed
 * before any caller sees that outcome, so a caller that retries at once computes again. A `compute` that throws
 * synchronously, or a `shouldCache` that throws, rejects the callers like any other failure.
 *
 * @param cache - Where the promises are kept: a `Map`, or an {@link LruMap} to bound how many are kept.
 */
export function getOrComputeAsync<K, V>(
  cache: { get(key: K): Promise<V> | undefined; set(key: K, value: Promise<V>): void; delete(key: K): boolean },
  key: K,
  compute: () => Promise<V>,
  { shouldCache }: { shouldCache?: (value: V) => boolean } = {},
): Promise<V> {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  // The key may have been removed and computed again while this promise was pending, and that newer entry must stay.
  const remove = () => {
    if (cache.get(key) === promise) {
      cache.delete(key);
    }
  };
  // `shouldCache` runs inside the promise callers await, and the rejection handler is attached before any caller's, so
  // the entry is gone by the time a caller resumes.
  const promise = (async () => {
    const value = await compute();
    if (shouldCache && !shouldCache(value)) {
      remove();
    }
    return value;
  })();
  promise.catch(remove);
  cache.set(key, promise);
  return promise;
}
