import { sleep } from '../sleep/index.js';
import { FifoMemoryQueue } from './fifo_memory_queue.js';
import { PriorityMemoryQueue } from './priority_memory_queue.js';

const queueFactories = [
  ['FIFO', () => new FifoMemoryQueue<number>()],
  ['priority', () => new PriorityMemoryQueue<number>((a, b) => a - b)],
] as const;

describe.each(queueFactories)('%s queue clear', (_name, createQueue) => {
  it('discards pending items and accepts new items', async () => {
    const queue = createQueue();
    queue.put(1);
    queue.put(2);
    queue.clear();
    expect(queue.length()).toBe(0);
    expect(queue.getImmediate()).toBeUndefined();
    expect(queue.put(3)).toBe(true);
    expect(await queue.get()).toBe(3);
  });

  it('preserves waiting consumers', async () => {
    const queue = createQueue();
    const next = queue.get();
    queue.clear();
    queue.put(3);
    expect(await next).toBe(3);
  });

  it('does not reopen an ended queue', async () => {
    const queue = createQueue();
    queue.put(1);
    queue.end();
    queue.clear();
    expect(queue.put(2)).toBe(false);
    expect(await queue.get()).toBeNull();
  });
});

describe.each(queueFactories)('%s queue process', (_name, createQueue) => {
  it('keeps consuming items after the handler throws', async () => {
    const queue = createQueue();
    queue.put(1);
    queue.put(2);
    queue.put(3);
    queue.end();

    const seen: number[] = [];
    await queue.process(item => {
      seen.push(item);
      if (item === 1) {
        throw new Error('handler failure');
      }
    });

    expect(seen).toEqual([1, 2, 3]);
  });

  it('keeps waiting for new items after an async handler rejects', async () => {
    const queue = createQueue();
    const seen: number[] = [];
    const processing = queue.process(item => {
      seen.push(item);
      return item === 1 ? Promise.reject(new Error('handler failure')) : Promise.resolve();
    });

    queue.put(1);
    // Let the rejection settle so the consumer is back to waiting before the next item arrives.
    await sleep(0);
    queue.put(2);
    queue.put(3);
    queue.end();
    await processing;

    expect(seen).toEqual([1, 2, 3]);
  });
});
