import { promiseWithResolvers } from '../promise/utils.js';
import { sleep } from '../sleep/index.js';
import { asyncPoolToCompletion } from './index.js';

describe('asyncPoolToCompletion', () => {
  it('returns results in input order', async () => {
    const delays = [30, 5, 20, 0, 10];
    const results = await asyncPoolToCompletion(2, delays, async (delay, index) => {
      await sleep(delay);
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  it('never runs more than the pool limit at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await asyncPoolToCompletion(
      3,
      Array.from({ length: 10 }, (_, i) => i),
      async i => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(i % 3);
        inFlight--;
      },
    );
    expect(maxInFlight).toBe(3);
  });

  it('waits for started calls to settle and starts no new ones after a failure', async () => {
    const slowSibling = promiseWithResolvers<void>();
    const started: number[] = [];
    let slowSiblingSettled = false;

    const pool = asyncPoolToCompletion(2, [0, 1, 2, 3], async i => {
      started.push(i);
      if (i === 0) {
        throw new Error('boom');
      }
      if (i === 1) {
        await slowSibling.promise;
        slowSiblingSettled = true;
      }
      return i;
    });

    let rejection: unknown;
    const settled = pool.catch(err => (rejection = err));
    await sleep(10);
    // The pool has not given up on the slow sibling, so it has not rejected yet.
    expect(rejection).toBeUndefined();

    slowSibling.resolve();
    await settled;

    expect(rejection).toEqual(new Error('boom'));
    expect(slowSiblingSettled).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it('rejects with the first error when several calls fail', async () => {
    const pool = asyncPoolToCompletion(2, [0, 1], async i => {
      await sleep(i * 10);
      throw new Error(`failure ${i}`);
    });
    await expect(pool).rejects.toThrow('failure 0');
  });

  it('rejects invalid pool limits', async () => {
    await expect(asyncPoolToCompletion(0, [1], () => Promise.resolve(1))).rejects.toThrow('Invalid pool limit');
  });
});
