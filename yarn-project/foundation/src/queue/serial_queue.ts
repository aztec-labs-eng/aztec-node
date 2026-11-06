import { FifoMemoryQueue } from './fifo_memory_queue.js';

/**
 * A more specialized fifo queue that enqueues functions to execute. Enqueued functions are executed in serial.
 *
 * Use this to keep async operations from interleaving (e.g. a read-modify-write on shared state) instead of a hand-rolled
 * `isRunning` flag or promise chain. `put(fn)` resolves or rejects with `fn`'s own result. Functions put before `start()`
 * wait in the queue until it is called. `end()` drains the queue, while `cancel()` drops whatever has not started (and
 * leaves those callers' `put` promises pending); both wait for the function in flight. For a bounded queue that applies backpressure, see `BoundedSerialQueue`; to cap
 * concurrency at more than one, see `Semaphore`.
 *
 * @example
 * private readonly queue = new SerialQueue();
 * // in start()
 * this.queue.start();
 * // anywhere
 * const result = await this.queue.put(() => this.updateState());
 * // in stop()
 * await this.queue.end();
 */
export class SerialQueue {
  private readonly queue = new FifoMemoryQueue<() => Promise<void>>();
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
    this.runningPromises = Array.from({ length: numWorkers }, () => this.queue.process(fn => fn()));
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
   * Cancels the processing of the remaining functions in the serial queue and resolves the running promise.
   * Any enqueued functions that have not yet been executed will be discarded, and the promises returned by their `put`
   * calls never settle. The queue cannot be reused: later `put` calls reject.
   *
   * @returns The running promise which resolves when the current executing function (if any) completes.
   */
  public cancel() {
    this.queue.cancel();
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
   * @returns A resolution promise. Rejects if the function does, or if the function could not be enqueued.
   */
  public put<T>(fn: () => T | Promise<T>): Promise<Awaited<T>> {
    return new Promise((resolve, reject) => {
      const accepted = this.queue.put(async () => {
        try {
          const res = await fn();
          resolve(res);
        } catch (e) {
          reject(e);
        }
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
