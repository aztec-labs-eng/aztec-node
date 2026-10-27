/**
 * Represents an error thrown when an operation is interrupted unexpectedly.
 * This custom error class extends the built-in Error class in JavaScript and
 * can be used to handle cases where a process or task is terminated before completion.
 */
export class InterruptError extends Error {
  public override readonly name = 'InterruptError';
}

/**
 * An error thrown when an action times out.
 */
export class TimeoutError extends Error {
  public override readonly name = 'TimeoutError';
}

/**
 * Represents an error thrown when an operation is aborted.
 */
export class AbortError extends Error {
  public override readonly name = 'AbortError';
}

/**
 * Whether a failure was environmental, and so may be retried: the process behind a call died, its
 * connection broke, or it could not be started.
 *
 * The bare `retry` property is the contract, feature-detected rather than imported, so the same check
 * holds across bb.js, ipc-runtime and ProvingError. An error without it failed for a reason retrying
 * cannot fix.
 */
export function isRetryableError(err: unknown): boolean {
  return err instanceof Error && 'retry' in err && err.retry === true;
}
