import { AbortError } from '../error/index.js';
import { FifoMemoryQueue } from './fifo_memory_queue.js';

/** A function waiting in a {@link SerialQueue}, with a way to reject its caller if it never runs. */
type QueuedFn = {
  run: () => Promise<void>;
  reject: (err: Error) => void;
};

/**
 * A more specialized fifo queue that enqueues functions to execute. Enqueued functions are executed in serial.
 * Cancelling the queue rejects the promises returned by `put` for any functions that had not started yet.
 */
export class SerialQueue {
  private readonly queue = new FifoMemoryQueue<QueuedFn>();
  private runningPromises: Promise<void>[] = [];
  private started = false;

  /**
   * Initializes the execution of enqueued functions in the serial queue.
   * Functions are executed in the order they were added to the queue, with each function
   * waiting for the completion of the previous one before starting its execution.
   * This method should be called once to start processing the queue.
   */
  public start(numWorkers = 1) {
    if (this.started) {
      return;
    }
    this.runningPromises = Array.from({ length: numWorkers }, () => this.queue.process(fn => fn.run()));
    this.started = true;
  }

  /**
   * Returns the current number of enqueued functions in the serial queue.
   * This provides a way to check the size of the queue and monitor its progress.
   *
   * @returns The length of the serial queue as a number.
   */
  public length() {
    return this.queue.length();
  }

  /**
   * Cancels the processing of the remaining functions in the serial queue. Functions that are already running are
   * left to finish. Enqueued functions that have not started are discarded, and the promises returned by their `put`
   * calls reject with an {@link AbortError}. The queue accepts no new functions after cancellation: later `put` calls
   * reject.
   *
   * @returns A promise which resolves when the functions running at the time of cancellation (if any) complete.
   */
  public cancel() {
    const discarded: QueuedFn[] = [];
    for (let fn = this.queue.getImmediate(); fn !== undefined; fn = this.queue.getImmediate()) {
      discarded.push(fn);
    }
    this.queue.cancel();
    for (const fn of discarded) {
      fn.reject(new AbortError('Serial queue was cancelled before the function ran'));
    }
    return Promise.all(this.runningPromises).then(() => {});
  }

  /**
   * Signals the SerialQueue that it should finish processing its current task and stop accepting new tasks.
   * The returned Promise resolves when all enqueued tasks have completed execution.
   *
   * @returns A Promise that resolves when the queue is completely emptied and no new tasks are allowed.
   */
  public end() {
    this.queue.end();
    return Promise.all(this.runningPromises).then(() => {});
  }

  /**
   * Enqueues fn for execution on the serial queue.
   * Returns the result of the function after execution.
   * @param fn - The function to enqueue.
   * @returns A resolution promise. Rejects if the function does, if the function could not be enqueued, or with an
   * {@link AbortError} if the queue is cancelled before the function starts.
   */
  public put<T>(fn: () => T | Promise<T>): Promise<Awaited<T>> {
    return new Promise((resolve, reject) => {
      const accepted = this.queue.put({
        run: async () => {
          try {
            const res = await fn();
            resolve(res);
          } catch (e) {
            reject(e);
          }
        },
        reject,
      });
      if (!accepted) {
        reject(new Error('Could not enqueue function'));
      }
    });
  }

  /**
   * Awaiting this ensures the queue is empty before resuming.
   */
  public async syncPoint() {
    await this.put(async () => {});
  }
}
