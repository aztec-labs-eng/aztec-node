import { FifoMemoryQueue } from './fifo_memory_queue.js';

export interface ISemaphore {
  acquire(): Promise<void>;
  release(): void;
}

/**
 * Allows the acquiring of up to `size` tokens before calls to acquire block, waiting for a call to release().
 * Blocked calls acquire in the order they were made: a released token goes to the one waiting longest, never to a
 * later call.
 */
export class Semaphore {
  private readonly queue = new FifoMemoryQueue<boolean>();
  private cancelled = false;

  constructor(size: number) {
    new Array(size).fill(true).map(() => this.queue.put(true));
  }

  /**
   * Acquires a token from the Semaphore, allowing access to a limited resource.
   * If no tokens are available, the call will block and wait until a token is released.
   * Use in conjunction with the release() method to manage access to resources with limited capacity.
   *
   * @returns A Promise that resolves when a token is acquired.
   */
  public async acquire() {
    await this.queue.get();
  }

  /**
   * Takes a token if one is free, without waiting. A token is never free while acquire() calls are waiting for one, so
   * this never takes one ahead of them.
   * @returns Whether the caller may proceed: a token was taken, or the semaphore is cancelled.
   */
  public tryAcquire(): boolean {
    return this.cancelled || this.queue.getImmediate() !== undefined;
  }

  /**
   * Releases a token back into the semaphore, allowing another acquire call to proceed.
   * If there are any pending calls to acquire(), the one waiting longest is unblocked and allowed to proceed.
   * This method should only be called by the holder of the acquired token to ensure proper functionality
   * and avoid unexpected behavior.
   */
  public release() {
    if (!this.cancelled) {
      this.queue.put(true);
    }
  }

  /**
   * Stops limiting access: every pending acquire() call proceeds, as does every later one (and tryAcquire() succeeds),
   * and release() does nothing.
   * Lets callers waiting for a token stop waiting once the resource is gone, so they must check for that themselves.
   */
  public cancel() {
    this.cancelled = true;
    this.queue.cancel();
  }
}
