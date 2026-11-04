import { times } from '../collection/index.js';
import { AbortError } from '../error/index.js';
import { promiseWithResolvers } from '../promise/utils.js';
import { sleep } from '../sleep/index.js';
import { Timer } from '../timer/timer.js';
import { SerialQueue } from './serial_queue.js';

describe('SerialQueue', () => {
  let queue: SerialQueue;
  let startSignals = new Array<boolean>();
  let endSignals = new Array<boolean>();
  let flag = false;

  const enqueuedFunction = async (index: number) => {
    startSignals[index] = true;
    while (!flag) {
      // Wait for flag to be set
      await sleep(10);
    }
    endSignals[index] = true;
  };

  const waitForJobs = async (timeoutSeconds: number) => {
    const timer = new Timer();
    let timedOut = false;
    while (startSignals.some(signal => !signal) && !timedOut) {
      await sleep(10);
      if (timer.s() > timeoutSeconds) {
        timedOut = true;
      }
    }
    // all start signals have been triggered
    // check that no end signals have been triggered
    expect(endSignals.some(signal => signal)).toBe(false);
    flag = true;
    return timedOut;
  };

  beforeEach(() => {
    queue = new SerialQueue();
  });

  afterEach(async () => {
    await queue.end();
  });

  it('processes multiple jobs concurrently', async () => {
    const numConcurrentJobs = 8;
    queue.start(8);
    startSignals = new Array(numConcurrentJobs).fill(false);
    endSignals = new Array(numConcurrentJobs).fill(false);
    const promises = times(numConcurrentJobs, i => queue.put(() => enqueuedFunction(i)));
    const timeout = await waitForJobs(30);
    await Promise.all(promises);
    expect(endSignals.every(signal => signal)).toBe(true);
    expect(timeout).toBe(false);
  });
});

describe('SerialQueue cancel', () => {
  /** Resolves to how the promise settled, or to 'pending' if it has not settled shortly after. */
  const settlement = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      sleep(100).then(() => 'pending'),
    ]);

  it('lets the running function finish and rejects the ones that had not started', async () => {
    const queue = new SerialQueue();
    queue.start();
    const release = promiseWithResolvers<void>();
    const running = queue.put(() => release.promise.then(() => 'done'));
    const queued = queue.put(() => 'never runs');

    const cancelled = queue.cancel();
    release.resolve();

    await expect(running).resolves.toEqual('done');
    await expect(settlement(queued)).resolves.toEqual('rejected');
    await expect(queued).rejects.toThrow(AbortError);
    await cancelled;
  });

  it('rejects functions put before the queue was started', async () => {
    const queue = new SerialQueue();
    const queued = queue.put(() => 'never runs');

    await queue.cancel();

    await expect(settlement(queued)).resolves.toEqual('rejected');
    await expect(queued).rejects.toThrow(AbortError);
  });

  it('rejects functions put after cancellation', async () => {
    const queue = new SerialQueue();
    queue.start();
    await queue.cancel();

    await expect(queue.put(() => 'never runs')).rejects.toThrow();
  });
});
