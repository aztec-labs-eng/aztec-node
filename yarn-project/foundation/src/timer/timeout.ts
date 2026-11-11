import { TimeoutError } from '../error/index.js';
import { promiseWithResolvers } from '../promise/utils.js';

/** Longest delay `setTimeout` honours; it fires larger ones almost at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Executes a function with a timeout. Use this instead of `Promise.race` against a `setTimeout` promise.
 *
 * On timeout the returned promise rejects, but `fn` keeps running unless it honours the `AbortSignal` it receives, so
 * pass the signal on to anything that accepts one (e.g. `fetch`). Once `fn` settles, the timeout has no further effect:
 * the signal never aborts and the error factory does not run.
 *
 * @param fn - The function to execute, accepts AbortSignal and returns a Promise.
 * @param timeout - The maximum time in milliseconds to allow the function to run: an integer from 0 to 2^31-1.
 * @param errorOrFnName - Optional function name or a function that returns an Error to throw if the timeout is reached.
 * @returns The result of `fn` if it completes within the timeout.
 */
export async function executeTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeout: number,
  errorOrFnName?: string | (() => Error),
): Promise<T> {
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `The value of "timeout" is out of range. It must be an integer >= 0 && <= ${MAX_TIMEOUT_MS}. Received ${timeout}`,
    );
  }
  const errorFn =
    typeof errorOrFnName === 'function'
      ? errorOrFnName
      : () => new TimeoutError(`Timeout running ${errorOrFnName ?? 'function'} after ${timeout}ms.`);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    timeout,
  );
  // Like `AbortSignal.timeout`, a pending timeout does not keep a Node process alive. Browsers have no `unref`.
  timer.unref?.();

  try {
    return await execWithSignal(fn, controller.signal, () => errorFn());
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Waits for the given promise, rejecting with a {@link TimeoutError} if it does not settle within the given timeout.
 * The timer is cleared as soon as either happens, so it never outlives the wait.
 *
 * @param opts - `unref` lets the process exit while the wait is still pending, for waits that bound a teardown.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
  opts: { unref?: boolean } = {},
): Promise<T> {
  const timedOut = promiseWithResolvers<never>();
  const timer = setTimeout(() => {
    timedOut.reject(new TimeoutError(errorMessage ?? `Operation timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  // Browsers hand back a number, which has nothing to unref and holds no process open.
  if (opts.unref && typeof timer === 'object') {
    timer.unref();
  }

  try {
    return await Promise.race([promise, timedOut.promise]);
  } finally {
    clearTimeout(timer);
  }
}
