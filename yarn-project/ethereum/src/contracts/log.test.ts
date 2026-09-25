import { fetchLogsBisectingRange, isLogRangeLimitError, isPersistentLogFetchError } from './log.js';

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

  it('completes a bisection that needs more requests than the range has blocks', async () => {
    const logBlocks = [1n, 300n, 600n];
    const { fetch, ranges } = providerRefusingWideRanges(2n, logBlocks);
    await expect(fetchLogsBisectingRange(1n, 600n, fetch)).resolves.toEqual(logBlocks);
    expect(ranges.length).toBeGreaterThan(600);
  });

  it('stops at the first block a range-limit refusal persists for, after a request per halving', async () => {
    const { fetch, ranges } = providerAlwaysFailing(new Error('query exceeds max block range 0'));
    await expect(fetchLogsBisectingRange(1n, 1024n, fetch)).rejects.toThrow('query exceeds max block range');
    expect(ranges).toHaveLength(11);
  });

  it('splits a range refused for its response size', async () => {
    const { fetch } = providerRefusingWideResponses(10n, [10n, 55n, 99n]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).resolves.toEqual([10n, 55n, 99n]);
  });

  it.each([
    ['an authentication failure', 'Must be authenticated!'],
    ['a rate limit', 'Your app has exceeded its compute units per second capacity'],
    ['missing state', 'missing trie node 0xabc (path )'],
    ['a pruned range', 'blocks in the requested block range are unavailable on this node'],
  ])('does not split on %s, and reports it as it arrived', async (_label, message) => {
    const { fetch, ranges } = providerAlwaysFailing(new Error(message));
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow(message);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('does not split on a rate-limited HTTP response, whatever its text', async () => {
    const err = new Error('HTTP request failed', { cause: Object.assign(new Error('Status: 429'), { status: 429 }) });
    const { fetch, ranges } = providerAlwaysFailing(err);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toBe(err);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('does not split on a rate-limited response whose text also reads as a range limit', async () => {
    const err = new Error('query timeout exceeded', { cause: { status: 429, cause: { message: 'slow down' } } });
    const { fetch, ranges } = providerAlwaysFailing(err);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toBe(err);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('reports a refusal in wording it does not recognize without splitting, even if a narrower range would work', async () => {
    const ranges: [bigint, bigint][] = [];
    const fetch = (fromBlock: bigint, toBlock: bigint) => {
      ranges.push([fromBlock, toBlock]);
      return toBlock - fromBlock + 1n > 10n
        ? Promise.reject(new Error('Requested range exceeds maximum RPC range limit'))
        : Promise.resolve([fromBlock]);
    };
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow('Requested range exceeds maximum RPC');
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('reports an unrecognized failure after a single request', async () => {
    const err = new Error('service temporarily unavailable');
    const { fetch, ranges } = providerAlwaysFailing(err);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toBe(err);
    expect(ranges).toEqual([[1n, 100n]]);
  });

  it('reports an interior block that fails in unrecognized wording rather than skipping it', async () => {
    const fetch = (fromBlock: bigint, toBlock: bigint) =>
      fromBlock <= 42n && 42n <= toBlock ? Promise.reject(new Error('internal error')) : Promise.resolve([fromBlock]);
    await expect(fetchLogsBisectingRange(1n, 100n, fetch)).rejects.toThrow('internal error');
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
    'eth_getLogs and eth_newFilter are limited to a 10,000 blocks range',
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

  it.each([
    'Must be authenticated!',
    'rate limit exceeded',
    '429 Too Many Requests',
    'missing trie node 0xabc',
    'header not found',
  ])('classifies %s as persistent', message => {
    expect(isPersistentLogFetchError(new Error(message))).toBe(true);
  });

  it.each(['query returned more than 10000 results', 'socket hang up', 'The request took too long to respond.'])(
    'does not classify %s as persistent',
    message => {
      expect(isPersistentLogFetchError(new Error(message))).toBe(false);
    },
  );

  it('reads the provider text out of a wrapped error cause', () => {
    const wrapped = new Error('HTTP request failed', { cause: new Error('query returned more than 10000 results') });
    expect(isLogRangeLimitError(wrapped)).toBe(true);
  });
});
