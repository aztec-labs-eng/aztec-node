import type { Buffer32 } from '@aztec-labs/foundation/buffer';

/** Base L1 event log with common fields. */
export type L1EventLog<T> = {
  /** L1 block number where the event was emitted. */
  l1BlockNumber: bigint;
  /** L1 block hash. */
  l1BlockHash: Buffer32;
  /** L1 transaction hash that emitted the event. */
  l1TransactionHash: `0x${string}`;
  /** Event-specific arguments. */
  args: T;
};

/**
 * Message fragments providers use to refuse a log query for being too wide or returning too much, the failures a
 * narrower range is known to fix. Matched on text because the JSON-RPC boundary leaves no error class or code behind
 * that is common across providers. A refusal worded some other way is reported rather than split on: see
 * {@link fetchLogsBisectingRange}.
 */
const LOG_RANGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /(exceeds?|exceeded|over|beyond|limited to|no more than|maximum|max) .{0,40}blocks? range/i,
  /blocks? range .{0,40}(too (large|wide|big)|exceed|limit)/i,
  /range is too (large|wide|big)/i,
  /too many (results|logs)/i,
  /query returned more than/i,
  /response size (is too large|exceeded)/i,
  /result set too large/i,
  /query timeout exceeded/i,
];

/**
 * Message fragments of failures no narrower range can fix — an authentication failure, a rate limit, state or history
 * the provider does not have — so splitting on them only multiplies the same request.
 */
const LOG_FETCH_PERSISTENT_FAILURE_PATTERNS: readonly RegExp[] = [
  /unauthori[sz]ed|forbidden|must be authenticated|invalid api key|api key is (missing|invalid)/i,
  /rate limit|too many requests|compute units per second/i,
  /missing trie node|header not found|unavailable on this node|pruned/i,
];

/** HTTP statuses a provider answers with for an authentication failure or a rate limit, whatever the range. */
const LOG_FETCH_PERSISTENT_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/** Whether a provider refused a log query for its range or response size, which a narrower range can fix. */
export function isLogRangeLimitError(err: unknown): boolean {
  const text = errorText(err);
  return LOG_RANGE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

/** Whether a log query failed for a reason that fails every sub-range too, such as authentication or a rate limit. */
export function isPersistentLogFetchError(err: unknown): boolean {
  if (errorChain(err).some(e => hasPersistentHttpStatus(e))) {
    return true;
  }
  const text = errorText(err);
  return LOG_FETCH_PERSISTENT_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

function hasPersistentHttpStatus(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    typeof err.status === 'number' &&
    LOG_FETCH_PERSISTENT_HTTP_STATUSES.has(err.status)
  );
}

/** An error followed by its causes, since viem nests the provider's own error, not always as an `Error`. */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    chain.push(current);
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return chain;
}

/** The messages of an error and its causes, since viem nests the provider's own text. */
function errorText(err: unknown): string {
  return errorChain(err)
    .map(e => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e)))
    .join(' | ');
}

/**
 * Fetches L1 logs in a block range, halving the range at complete-block boundaries when the provider refuses it for
 * its range or response size.
 *
 * Only a refusal worded as a range or response-size limit is split on, and not when it also carries the marks of a
 * failure that fails every sub-range too (an authentication failure, a rate limit, state the provider does not have).
 * Anything else is rethrown as it arrived. Splitting on an unrecognized failure would turn one outage into hundreds of
 * identical requests before reporting the same thing, and telling a range refusal apart from an outage by probing a
 * narrower range adds requests and a heuristic that can misread a flaky provider. Failing is deliberate: a provider
 * whose range-limit wording is not recognized is fixed by adding its wording to {@link LOG_RANGE_LIMIT_PATTERNS}, and
 * the caller retries the whole fetch on its next sync.
 *
 * No request budget caps a call, because the recursion bounds itself: a refusal that persists down to a single block
 * is thrown once the halving reaches that block, and a provider that serves only narrow ranges costs fewer than two
 * requests per block in the range. A budget below that bound would fail a window that is making progress, and since
 * the window is fetched again whole on the next sync, it would fail the same way every time.
 *
 * A single block the provider cannot serve is a provider or history failure and is thrown as such: a range this
 * function returns is complete, and a failure is never reported as an absence of logs.
 */
export async function fetchLogsBisectingRange<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  let result: readonly T[];
  try {
    result = await fetch(fromBlock, toBlock);
  } catch (err) {
    if (fromBlock >= toBlock || !shouldSplit(err)) {
      throw err;
    }
    const midBlock = fromBlock + (toBlock - fromBlock) / 2n;
    const [lower, upper] = [
      await fetchLogsBisectingRange(fromBlock, midBlock, fetch),
      await fetchLogsBisectingRange(midBlock + 1n, toBlock, fetch),
    ];
    return [...lower, ...upper];
  }
  return [...result];
}

/** Whether a multi-block range that failed with `err` should be split. */
function shouldSplit(err: unknown): boolean {
  // Persistent first: a rate-limited response whose text also reads as a range limit still fails every sub-range.
  return !isPersistentLogFetchError(err) && isLogRangeLimitError(err);
}
