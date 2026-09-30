import { FifoMemoryQueue } from './fifo_memory_queue.js';
import { PriorityMemoryQueue } from './priority_memory_queue.js';

describe.each([
  ['FIFO', () => new FifoMemoryQueue<number>()],
  ['priority', () => new PriorityMemoryQueue<number>((a, b) => a - b)],
] as const)('%s queue clear', (_name, createQueue) => {
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
