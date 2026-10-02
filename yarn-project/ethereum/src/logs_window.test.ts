import type { HttpTransport } from 'viem';

import { capLogsWindow, splitLogsWindow } from './logs_window.js';

type Request = { method: string; params?: unknown };

/** A transport that answers every request from `handler` and records what it was asked for. */
function makeRecordingTransport(handler: (args: Request) => unknown) {
  const requests: Request[] = [];
  const transport = ((_parameters: unknown) => ({
    config: {},
    value: undefined,
    request: (args: Request) => {
      requests.push(args);
      return Promise.resolve(handler(args));
    },
  })) as unknown as HttpTransport;
  return { transport, requests };
}

/** The log ranges an `eth_getLogs` request asked for, as numbers. */
function logsRanges(requests: Request[]): { fromBlock: unknown; toBlock: unknown }[] {
  return requests
    .filter(r => r.method === 'eth_getLogs')
    .map(r => (r.params as [{ fromBlock: unknown; toBlock: unknown }])[0])
    .map(({ fromBlock, toBlock }) => ({
      fromBlock: typeof fromBlock === 'string' && fromBlock.startsWith('0x') ? Number(BigInt(fromBlock)) : fromBlock,
      toBlock: typeof toBlock === 'string' && toBlock.startsWith('0x') ? Number(BigInt(toBlock)) : toBlock,
    }));
}

function makeCappedRequest(
  maxWindowSize: number,
  handler: (args: Request) => unknown,
): { request: (args: Request) => Promise<any>; requests: Request[] } {
  const { transport, requests } = makeRecordingTransport(handler);
  const capped = capLogsWindow(transport, maxWindowSize)({} as never);
  return { request: args => (capped.request as (args: Request) => Promise<any>)(args), requests };
}

/** The methods the cap uses to turn a moving tag into a height. */
const TAG_RESOLUTION_METHODS = ['eth_blockNumber', 'eth_getBlockByNumber'];

/** Answers a tag resolution with `head` and `eth_getLogs` with one log naming the range it covered. */
function answerFromHead(head: bigint | undefined) {
  return (args: Request) => {
    if (args.method === 'eth_blockNumber') {
      return head === undefined ? undefined : `0x${head.toString(16)}`;
    }
    if (args.method === 'eth_getBlockByNumber') {
      return head === undefined ? null : { number: `0x${head.toString(16)}` };
    }
    const [{ fromBlock, toBlock }] = args.params as [{ fromBlock?: string; toBlock?: string }];
    return [{ range: `${fromBlock}-${toBlock}` }];
  };
}

describe('splitLogsWindow', () => {
  it('returns a single window for a range that fits', () => {
    expect([...splitLogsWindow(10n, 19n, 10)]).toEqual([{ fromBlock: 10n, toBlock: 19n }]);
  });

  it('tiles a range that is an exact multiple of the window size', () => {
    expect([...splitLogsWindow(0n, 5n, 2)]).toEqual([
      { fromBlock: 0n, toBlock: 1n },
      { fromBlock: 2n, toBlock: 3n },
      { fromBlock: 4n, toBlock: 5n },
    ]);
  });

  it('clips the last window of a range that is not a multiple of the window size', () => {
    expect([...splitLogsWindow(10n, 14n, 2)]).toEqual([
      { fromBlock: 10n, toBlock: 11n },
      { fromBlock: 12n, toBlock: 13n },
      { fromBlock: 14n, toBlock: 14n },
    ]);
  });

  it('splits into single blocks at a window size of one', () => {
    expect([...splitLogsWindow(7n, 9n, 1)]).toEqual([
      { fromBlock: 7n, toBlock: 7n },
      { fromBlock: 8n, toBlock: 8n },
      { fromBlock: 9n, toBlock: 9n },
    ]);
  });

  it('returns no window for an inverted range', () => {
    expect([...splitLogsWindow(10n, 9n, 5)]).toEqual([]);
  });

  it('yields windows without materialising them all', () => {
    const windows = splitLogsWindow(0n, 10n ** 9n, 1);
    expect(windows.next().value).toEqual({ fromBlock: 0n, toBlock: 0n });
    expect(windows.next().value).toEqual({ fromBlock: 1n, toBlock: 1n });
  });
});

describe('capLogsWindow', () => {
  it('rejects a window size that is not a positive integer', () => {
    const { transport } = makeRecordingTransport(() => []);
    expect(() => capLogsWindow(transport, 0)).toThrow('positive integer');
    expect(() => capLogsWindow(transport, -1)).toThrow('positive integer');
    expect(() => capLogsWindow(transport, 1.5)).toThrow('positive integer');
  });

  it('passes a range that fits through untouched', async () => {
    const { request, requests } = makeCappedRequest(100, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ address: '0xabc', fromBlock: '0xa', toBlock: '0x64' }] });
    expect(requests).toEqual([
      { method: 'eth_getLogs', params: [{ address: '0xabc', fromBlock: '0xa', toBlock: '0x64' }] },
    ]);
  });

  it('passes a range of exactly the window size through untouched', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0xa' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 1, toBlock: 10 }]);
  });

  it('splits a range one block wider than the window size', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0xb' }] });
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 1, toBlock: 10 },
      { fromBlock: 11, toBlock: 11 },
    ]);
  });

  it('tiles a wide range and concatenates the logs in order', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    const logs = await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0x18' }] });
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
      { fromBlock: 20, toBlock: 24 },
    ]);
    expect(logs).toEqual([{ range: '0x0-0x9' }, { range: '0xa-0x13' }, { range: '0x14-0x18' }]);
  });

  it('keeps the rest of the filter on every window', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    const topics = ['0xdead'];
    await request({ method: 'eth_getLogs', params: [{ address: '0xabc', topics, fromBlock: '0x0', toBlock: '0x13' }] });
    for (const req of requests) {
      expect((req.params as [{ address: string; topics: string[] }])[0]).toMatchObject({ address: '0xabc', topics });
    }
  });

  it('resolves a moving upper bound so the range can be split', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(24n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
      { fromBlock: 20, toBlock: 24 },
    ]);
  });

  it('treats an absent upper bound as latest', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(24n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0' }] });
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
      { fromBlock: 20, toBlock: 24 },
    ]);
  });

  it('resolves an earliest lower bound to the genesis block', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(15n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: 'earliest', toBlock: 'latest' }] });
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 15 },
    ]);
  });

  it('resolves each distinct moving tag once for a request', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(30n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(requests.filter(r => TAG_RESOLUTION_METHODS.includes(r.method))).toHaveLength(1);
  });

  it('resolves latest without downloading the block', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(30n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(requests.filter(r => TAG_RESOLUTION_METHODS.includes(r.method))).toEqual([{ method: 'eth_blockNumber' }]);
  });

  it('pins a resolved moving bound even when the range already fits', async () => {
    const { request, requests } = makeCappedRequest(100, answerFromHead(24n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 0, toBlock: 24 }]);
  });

  it('keeps a pinned single window within the cap when the chain advances mid-request', async () => {
    let head = 9n;
    const { request, requests } = makeCappedRequest(10, (args: Request) => {
      if (TAG_RESOLUTION_METHODS.includes(args.method)) {
        return `0x${head.toString(16)}`;
      }
      head += 1n;
      const [{ fromBlock, toBlock }] = args.params as [{ fromBlock?: string; toBlock?: string }];
      if (BigInt(toBlock!) - BigInt(fromBlock!) + 1n > 10n) {
        throw new Error('query exceeds max block range');
      }
      return [];
    });

    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 0, toBlock: 9 }]);
  });

  it('does not resolve anything when both bounds name the same moving tag', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(30n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: 'latest', toBlock: 'latest' }] });
    expect(requests.map(r => r.method)).toEqual(['eth_getLogs']);
  });

  it('passes a pending bound through rather than giving it a canonical height', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(30n));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'pending' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 0, toBlock: 'pending' }]);
  });

  it('passes the query through when the provider cannot answer the tag', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'finalized' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 0, toBlock: 'finalized' }]);
  });

  it('passes the query through when resolving the tag fails', async () => {
    const { request, requests } = makeCappedRequest(10, (args: Request) => {
      if (TAG_RESOLUTION_METHODS.includes(args.method)) {
        throw new Error(`method ${args.method} is not available`);
      }
      return [];
    });
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 0, toBlock: 'latest' }]);
  });

  it('concatenates windows holding far more logs than fit in an argument list', async () => {
    const perWindow = 200_000;
    const { request } = makeCappedRequest(10, (args: Request) => {
      if (args.method !== 'eth_getLogs') {
        return null;
      }
      const [{ fromBlock }] = args.params as [{ fromBlock: string }];
      return new Array(perWindow).fill({ from: fromBlock });
    });

    const logs = (await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0x13' }] })) as {
      from: string;
    }[];
    expect(logs).toHaveLength(perWindow * 2);
    expect(logs[0].from).toEqual('0x0');
    expect(logs[perWindow].from).toEqual('0xa');
  });

  it('passes an inverted range through for the provider to reject', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0x64', toBlock: '0xa' }] });
    expect(logsRanges(requests)).toEqual([{ fromBlock: 100, toBlock: 10 }]);
  });

  it('passes a filter whose bounds are not strings through untouched', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: 1, toBlock: 5 }] });
    expect(requests).toEqual([{ method: 'eth_getLogs', params: [{ fromBlock: 1, toBlock: 5 }] }]);
  });

  it('passes a bound that is not a valid quantity through untouched', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ fromBlock: '0xnope', toBlock: '0x5' }] });
    expect(requests).toEqual([{ method: 'eth_getLogs', params: [{ fromBlock: '0xnope', toBlock: '0x5' }] }]);
  });

  it('passes a by-hash filter through untouched', async () => {
    const { request, requests } = makeCappedRequest(10, answerFromHead(undefined));
    await request({ method: 'eth_getLogs', params: [{ blockHash: '0xfeed' }] });
    expect(requests).toEqual([{ method: 'eth_getLogs', params: [{ blockHash: '0xfeed' }] }]);
  });

  it('leaves other methods alone', async () => {
    const { request, requests } = makeCappedRequest(10, () => '0x1');
    await request({ method: 'eth_blockNumber' });
    expect(requests).toEqual([{ method: 'eth_blockNumber' }]);
  });

  it('fails the whole request when a window is rejected, rather than returning the windows before it', async () => {
    const { request, requests } = makeCappedRequest(10, (args: Request) => {
      if (args.method !== 'eth_getLogs') {
        return null;
      }
      const [{ fromBlock }] = args.params as [{ fromBlock: string }];
      if (BigInt(fromBlock) === 10n) {
        throw new Error('query returned more than 10000 results');
      }
      return [{ range: fromBlock }];
    });

    await expect(request({ method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: '0x18' }] })).rejects.toThrow(
      'more than 10000 results',
    );
    expect(logsRanges(requests)).toEqual([
      { fromBlock: 0, toBlock: 9 },
      { fromBlock: 10, toBlock: 19 },
    ]);
  });
});
