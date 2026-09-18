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
 * Message fragments providers use to refuse a log query for being too wide or returning too much, the only failures
 * a narrower range can fix. Matched on text because the JSON-RPC boundary leaves no error class or code behind that
 * is common across providers, and deliberately narrow: an authentication failure, a rate limit, an outage or a
 * pruned state range all fail every sub-range too, so splitting on them only multiplies the same request.
 */
const LOG_RANGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /block range/i,
  /range is too (large|wide)/i,
  /too many (results|logs)/i,
  /query returned more than/i,
  /response size (is too large|exceeded)/i,
  /result set too large/i,
  /query timeout exceeded/i,
];

/**
 * Upper bound on the fetches one {@link fetchLogsBisectingRange} call may make, as a safety net for a provider whose
 * range-limit text this classifier reads but whose splits never start succeeding. Generous enough for a legitimate
 * bisection down to single blocks over the windows this repo queries.
 */
const MAX_LOG_FETCH_CALLS = 512;

/** Whether a provider refused a log query for its range or response size, which a narrower range can fix. */
export function isLogRangeLimitError(err: unknown): boolean {
  const text = errorText(err);
  return LOG_RANGE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

/** The message of an error together with those of its causes, since viem nests the provider's own text. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (!(current instanceof Error)) {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

/**
 * Fetches L1 logs in a block range, halving the range at complete-block boundaries when the provider refuses it for
 * its range or response size. Every other failure — authentication, rate limiting, an outage, state the provider no
 * longer has — is rethrown as it arrived: it would fail every sub-range too, so splitting would turn one failure
 * into hundreds of identical requests before reporting the same thing.
 *
 * A single block the provider cannot serve is a provider or history failure and is thrown as such: a range this
 * function returns is complete, and a failure is never reported as an absence of logs.
 */
export function fetchLogsBisectingRange<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  return fetchLogsWithinBudget(fromBlock, toBlock, fetch, { remainingCalls: MAX_LOG_FETCH_CALLS });
}

async function fetchLogsWithinBudget<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
  budget: { remainingCalls: number },
): Promise<T[]> {
  if (budget.remainingCalls <= 0) {
    throw new Error(
      `Exhausted the ${MAX_LOG_FETCH_CALLS} request budget splitting an L1 log range; last attempted [${fromBlock}, ${toBlock}]`,
    );
  }
  budget.remainingCalls--;
  try {
    return [...(await fetch(fromBlock, toBlock))];
  } catch (err) {
    if (fromBlock >= toBlock || !isLogRangeLimitError(err)) {
      throw err;
    }
    const midBlock = fromBlock + (toBlock - fromBlock) / 2n;
    const [lower, upper] = [
      await fetchLogsWithinBudget(fromBlock, midBlock, fetch, budget),
      await fetchLogsWithinBudget(midBlock + 1n, toBlock, fetch, budget),
    ];
    return [...lower, ...upper];
  }
}
