import { jest } from '@jest/globals';

import { TimeoutError } from '../error/index.js';
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

describe.each([
  ['FIFO', () => new FifoMemoryQueue<number>()],
  ['priority', () => new PriorityMemoryQueue<number>((a, b) => a - b)],
] as const)('%s queue get with timeout', (_name, createQueue) => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects when no item arrives in time', async () => {
    const queue = createQueue();
    const next = queue.get(1);
    jest.advanceTimersByTime(1000);
    await expect(next).rejects.toThrow(TimeoutError);
  });

  it('leaves no timer pending once an item arrives', async () => {
    const queue = createQueue();
    const next = queue.get(60);
    queue.put(1);
    expect(await next).toBe(1);
    expect(jest.getTimerCount()).toEqual(0);
  });

  it('leaves no timer pending once the queue ends', async () => {
    const queue = createQueue();
    const next = queue.get(60);
    queue.end();
    expect(await next).toBeNull();
    expect(jest.getTimerCount()).toEqual(0);
  });
});
