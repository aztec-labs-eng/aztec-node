import { TimeoutError } from '../error/index.js';
import { promiseWithResolvers } from '../promise/utils.js';
import { Timer } from './timer.js';

/** Longest delay `setTimeout` honours; it fires larger ones almost at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * TimeoutTask class creates an instance for managing and executing a given asynchronous function with a specified timeout duration.
 * The task will be automatically interrupted if it exceeds the given timeout duration, and will throw a custom error message.
 * Additional information such as execution time can be retrieved using getTime method after the task has been executed.
 *
 * @typeparam T - The return type of the asynchronous function to be executed.
 */
export class TimeoutTask<T> {
  private totalTime = 0;

  constructor(
    private fn: (signal: AbortSignal) => Promise<T>,
    private timeout: number,
    private errorFn: () => Error,
    private onAbort?: () => void,
  ) {}

  /**
   * Executes the given function with a specified timeout.
   * If the function takes longer than the timeout, it will be interrupted and an error will be thrown.
   * Once the function settles, the timeout has no further effect: the signal passed to it never aborts and `onAbort`
   * does not run.
   * The total execution time of the function will be stored in the totalTime property.
   *
   * @returns The result of the executed function if completed within the timeout.
   * @throws An error with a message indicating the function was interrupted due to exceeding the specified timeout.
   */
  public async exec() {
    if (!Number.isInteger(this.timeout) || this.timeout < 0 || this.timeout > MAX_TIMEOUT_MS) {
      throw new RangeError(
        `The value of "timeout" is out of range. It must be an integer >= 0 && <= ${MAX_TIMEOUT_MS}. Received ${this.timeout}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      this.timeout,
    );
    // Like `AbortSignal.timeout`, a pending timeout does not keep a Node process alive. Browsers have no `unref`.
    timer.unref?.();

    const executionTimer = new Timer();
    try {
      return await execWithSignal(this.fn, controller.signal, () => {
        this.onAbort?.();
        return this.errorFn();
      });
    } finally {
      clearTimeout(timer);
      this.totalTime = executionTimer.ms();
    }
  }

  /**
   * Get the total time spent on the most recent execution of the wrapped function.
   * This method provides the duration from the start to the end of the function execution, whether it completed or timed out.
   *
   * @returns The total time in milliseconds spent on the most recent function execution.
   */
  public getTime() {
    return this.totalTime;
  }
}

/**
 * Executes a function with a timeout. Use this instead of `Promise.race` against a `setTimeout` promise.
 *
 * On timeout the returned promise rejects, but `fn` keeps running unless it honours the `AbortSignal` it receives, so
 * pass the signal on to anything that accepts one (e.g. `fetch`). Once `fn` settles, the timeout has no further effect:
 * the signal never aborts, and neither `onAbort` nor the error factory runs.
 *
 * @param fn - The function to execute, accepts AbortSignal and returns a Promise.
 * @param timeout - The maximum time in milliseconds to allow the function to run.
 * @param errorOrFnName - Optional function name or a function that returns an Error to throw if the timeout is reached.
 * @param onAbort - Optional callback to execute when the task is aborted.
 *
 * @returns A Promise that resolves with the result of the function fn if it completes within the timeout
 *
 * */
export async function executeTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeout: number,
  errorOrFnName?: string | (() => Error),
  onAbort?: () => void,
) {
  const errorFn =
    typeof errorOrFnName === 'function'
      ? errorOrFnName
      : () => new TimeoutError(`Timeout running ${errorOrFnName ?? 'function'} after ${timeout}ms.`);
  const task = new TimeoutTask(fn, timeout, errorFn, onAbort);
  return await task.exec();
}

function defaultSignalError(signal: AbortSignal) {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }

  return new Error(signal.reason ? String(signal.reason) : 'Operation aborted');
}

/**
 * Executes a function until it completes or the given signal aborts. On abort, rejects with the error from `errorFn`, or
 * with what `errorFn` throws. That error wins over a rejection from an abort handler that `fn` adds to `signal`, since
 * those handlers run after this function's own.
 */
export async function execWithSignal<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  errorFn: (signal: AbortSignal) => Error = defaultSignalError,
) {
  if (signal.aborted) {
    throw errorFn(signal);
  }

  const abortPromise = promiseWithResolvers<never>();
  const abortListener = () => {
    try {
      abortPromise.reject(errorFn(signal));
    } catch (err) {
      abortPromise.reject(err);
    }
  };
  signal.addEventListener('abort', abortListener, { once: true });

  try {
    return await Promise.race<T>([fn(signal), abortPromise.promise]);
  } finally {
    signal.removeEventListener('abort', abortListener);
  }
}

/** Returns a promise that rejects after the given timeout */
export function timeoutPromise(timeoutMs: number, errorMessage?: string) {
  const promise = promiseWithResolvers<never>();

  const timer = setTimeout(() => {
    promise.reject(new TimeoutError(errorMessage ?? `Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const cleanup = () => clearTimeout(timer);
  return promise.promise.finally(cleanup);
}
