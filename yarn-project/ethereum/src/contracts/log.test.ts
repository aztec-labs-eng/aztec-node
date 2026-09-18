import { fetchLogsBisectingRange, isLogRangeLimitError } from './log.js';

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

  /** As {@link providerRefusingWideRanges}, but refusing with the response-size wording instead. */
  const providerRefusingWideResponses = (maxRange: bigint, logBlocks: bigint[]) => ({
    fetch: (fromBlock: bigint, toBlock: bigint) =>
      toBlock - fromBlock + 1n > maxRange
        ? Promise.reject(new Error('query returned more than 10000 results'))
        : Promise.resolve(logBlocks.filter(block => block >= fromBlock && block <= toBlock)),
  });

  /** A provider that always fails with the same error, recording how many times it was asked. */
  const providerAlwaysFailing = (err: Error) => {
    const ranges: [bigint, bigint][] = [];
    const fetch = (fromBlock: bigint, toBlock: bigint) => {
      ranges.push([fromBlock, toBlock]);
      return Promise.reject(err);
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

  it('splits a range refused for its response size', async () => {
    const { fetch } = providerRefusingWideResponses(10n, [10n, 55n, 99n]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).resolves.toEqual([10n, 55n, 99n]);
  });

  it.each([
    ['an authentication failure', 'Must be authenticated!'],
    ['a rate limit', 'Your app has exceeded its compute units per second capacity'],
    ['an outage', 'service temporarily unavailable'],
    ['missing state', 'missing trie node 0xabc (path )'],
    ['a pruned range', 'blocks in the requested block range are unavailable on this node'],
  ])('does not split on %s, and reports it as it arrived', async (_label, message) => {
    const { fetch, ranges } = providerAlwaysFailing(new Error(message));
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow(message);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('reports a single block the provider cannot serve as a failure rather than an absence of logs', async () => {
    const fetch = (fromBlock: bigint, toBlock: bigint) =>
      fromBlock <= 42n && 42n <= toBlock
        ? Promise.reject(new Error('missing trie node'))
        : Promise.resolve([fromBlock]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow('missing trie node');
  });

  it('propagates a one-block range-limit failure unchanged rather than splitting further', async () => {
    const { fetch, ranges } = providerAlwaysFailing(new Error('exceed maximum block range: 0'));
    await expect(fetchLogsBisectingRange(7n, 7n, fetch)).rejects.toThrow('exceed maximum block range');
    expect(ranges).toEqual([[7n, 7n]]);
  });
});

describe('isLogRangeLimitError', () => {
  it.each([
    'query exceeds max block range 10',
    'eth_getLogs is limited to a 10000 block range',
    'query returned more than 10000 results',
    'Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    'query timeout exceeded',
  ])('classifies %s as a range limit', message => {
    expect(isLogRangeLimitError(new Error(message))).toBe(true);
  });

  it.each([
    'Must be authenticated!',
    'Your app has exceeded its compute units per second capacity',
    'rate limit exceeded',
    'missing trie node 0xabc',
    'socket hang up',
    'blocks in the requested block range are unavailable on this node',
  ])('does not classify %s as a range limit', message => {
    expect(isLogRangeLimitError(new Error(message))).toBe(false);
  });

  it('reads the provider text out of a wrapped error cause', () => {
    const wrapped = new Error('HTTP request failed', { cause: new Error('query returned more than 10000 results') });
    expect(isLogRangeLimitError(wrapped)).toBe(true);
  });
});
