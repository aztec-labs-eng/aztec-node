import { sleep } from '../sleep/index.js';
import { Semaphore } from './semaphore.js';

const PENDING = Symbol('pending');

/** Whether `promise` has settled once pending callbacks have run. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  return (await Promise.race([promise, sleep(0, PENDING)])) !== PENDING;
}

describe('Semaphore', () => {
  it('blocks acquire once its tokens are taken, until one is released', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const waiting = semaphore.acquire();
    expect(await isSettled(waiting)).toBe(false);

    semaphore.release();
    expect(await isSettled(waiting)).toBe(true);
  });

  it('hands released tokens to blocked calls in the order they were made, ahead of later calls', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const first = semaphore.acquire();
    const second = semaphore.acquire();

    semaphore.release();
    const later = semaphore.acquire();
    expect(await isSettled(first)).toBe(true);
    expect(await isSettled(second)).toBe(false);
    expect(await isSettled(later)).toBe(false);

    semaphore.release();
    expect(await isSettled(second)).toBe(true);
    expect(await isSettled(later)).toBe(false);
  });

  it('lets pending and later acquire calls through once cancelled', async () => {
    const semaphore = new Semaphore(1);
    await semaphore.acquire();
    const waiting = Promise.all([semaphore.acquire(), semaphore.acquire()]);

    semaphore.cancel();

    expect(await isSettled(waiting)).toBe(true);
    expect(await isSettled(semaphore.acquire())).toBe(true);
  });
});
