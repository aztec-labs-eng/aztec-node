import { fetchLogsBisectingRange } from './log.js';

describe('fetchLogsBisectingRange', () => {
  /** A provider that serves logs one per L1 block but refuses any range wider than `maxRange` blocks. */
  const providerRefusingWideRanges = (maxRange: bigint, logBlocks: bigint[]) => {
    const ranges: [bigint, bigint][] = [];
    const fetch = (fromBlock: bigint, toBlock: bigint) => {
      ranges.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1n > maxRange) {
        return Promise.reject(new Error(`query exceeds max block range ${maxRange}`));
      }
      return Promise.resolve(logBlocks.filter(block => block >= fromBlock && block <= toBlock));
    };
    return { fetch, ranges };
  };

  it('returns every log in the range in order when the provider serves it whole', async () => {
    const { fetch, ranges } = providerRefusingWideRanges(100n, [10n, 55n, 99n]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).resolves.toEqual([10n, 55n, 99n]);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('splits a refused range into complete sub-ranges and returns their logs in block order', async () => {
    const { fetch, ranges } = providerRefusingWideRanges(10n, [10n, 55n, 99n]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).resolves.toEqual([10n, 55n, 99n]);

    const served = ranges.filter(([from, to]) => to - from + 1n <= 10n);
    expect(served[0][0]).toEqual(1n);
    expect(served.at(-1)![1]).toEqual(100n);
    // The served sub-ranges tile the requested range exactly: no block is skipped and none is queried twice.
    expect(served.slice(1).map(([from]) => from)).toEqual(served.slice(0, -1).map(([, to]) => to + 1n));
  });

  it('reports a single block the provider cannot serve as a failure rather than an absence of logs', async () => {
    const fetch = (fromBlock: bigint, toBlock: bigint) =>
      fromBlock <= 42n && 42n <= toBlock
        ? Promise.reject(new Error('missing trie node'))
        : Promise.resolve([fromBlock]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow('missing trie node');
  });
});
