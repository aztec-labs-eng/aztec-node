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
 * Fetches L1 logs in a block range, halving the range at complete-block boundaries when the provider rejects it
 * (typically a log-range or response-size limit). A single block the provider cannot serve is a provider or history
 * failure and is thrown as such: a range this function returns is complete, and a failure is never reported as an
 * absence of logs.
 */
export async function fetchLogsBisectingRange<T>(
  fromBlock: bigint,
  toBlock: bigint,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<readonly T[]>,
): Promise<T[]> {
  try {
    return [...(await fetch(fromBlock, toBlock))];
  } catch (err) {
    if (fromBlock >= toBlock) {
      throw err;
    }
    const midBlock = fromBlock + (toBlock - fromBlock) / 2n;
    const [lower, upper] = [
      await fetchLogsBisectingRange(fromBlock, midBlock, fetch),
      await fetchLogsBisectingRange(midBlock + 1n, toBlock, fetch),
    ];
    return [...lower, ...upper];
  }
}
