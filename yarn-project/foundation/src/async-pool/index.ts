/*
 * Adapted from https://github.com/rxaviers/async-pool/blob/1.x/lib/es6.js
 *
 * Copyright (c) 2017 Rafael Xavier de Souza http://rafael.xavier.blog.br
 *
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use,
 * copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 * OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 * WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 * OTHER DEALINGS IN THE SOFTWARE.
 */

/** Executes the given async function over the iterable, up to a determined number of promises in parallel. */
export function asyncPool<T, R>(poolLimit: number, iterable: T[], iteratorFn: (item: T, iterable: T[]) => Promise<R>) {
  let i = 0;
  const ret: Promise<R>[] = [];
  // eslint-disable-next-line aztec-custom/no-non-primitive-in-collections
  const executing: Set<Promise<R>> = new Set();
  const enqueue = (): Promise<any> => {
    if (i === iterable.length) {
      return Promise.resolve();
    }
    const item = iterable[i++];
    const p = Promise.resolve().then(() => iteratorFn(item, iterable));
    ret.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    let r: Promise<any> = Promise.resolve();
    if (executing.size >= poolLimit) {
      r = Promise.race(executing);
    }
    return r.then(() => enqueue());
  };
  return enqueue().then(() => Promise.all(ret));
}

/**
 * Runs `iteratorFn` over `items` with at most `poolLimit` calls in flight, returning results in input order.
 *
 * Unlike {@link asyncPool}, a failure does not abandon the calls still running: no new call starts once one has
 * failed, and the returned promise rejects with the first error only after every started call has settled. Use it when
 * the calls depend on a resource (such as a transaction) that the caller releases as soon as this promise settles.
 */
export async function asyncPoolToCompletion<T, R>(
  poolLimit: number,
  items: readonly T[],
  iteratorFn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(poolLimit) || poolLimit < 1) {
    throw new Error(`Invalid pool limit: ${poolLimit}`);
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;

  const worker = async () => {
    while (failure === undefined && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await iteratorFn(items[index], index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(poolLimit, items.length) }, worker));
  if (failure !== undefined) {
    throw failure.error;
  }
  return results;
}
