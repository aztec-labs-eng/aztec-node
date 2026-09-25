import { startHttpRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { type Server, createServer } from 'node:http';
import { createPublicClient } from 'viem';
import { foundry } from 'viem/chains';

import { L1RpcError, getL1RpcHttpStatus, isL1RpcHttpStatus, makeL1HttpTransport } from './client.js';

async function startRateLimitedL1Server(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected L1 test server to listen on a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('makeL1HttpTransport', () => {
  let l1Server: Server | undefined;
  let rpcHttpServer: Awaited<ReturnType<typeof startHttpRpcServer>> | undefined;

  afterEach(() => {
    rpcHttpServer?.close();
    l1Server?.close();
    rpcHttpServer = undefined;
    l1Server = undefined;
  });

  it('wraps transport errors while preserving the HTTP status in the cause chain', async () => {
    const l1 = await startRateLimitedL1Server();
    l1Server = l1.server;
    const l1Client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([l1.url]),
    });

    let error: unknown;
    try {
      await l1Client.getChainId();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(L1RpcError);
    expect(error).toMatchObject({ message: 'L1 RPC request failed' });
    expect(String(error)).toEqual('L1RpcError: L1 RPC request failed');
    expect(getL1RpcHttpStatus(error)).toBe(429);
    expect(isL1RpcHttpStatus(error, 429)).toBe(true);
  });
});

/**
 * Starts an L1 endpoint that rejects any `eth_getLogs` spanning more than `maxSpan` blocks, as a provider with a
 * log-range cap does, and answers the ones it accepts with a single log naming the range it covered.
 */
async function startRangeCappedL1Server(
  maxSpan: bigint,
  opts: { failLogsRequestsAfter?: number } = {},
): Promise<{ server: Server; url: string; logRanges: string[] }> {
  const logRanges: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number;
        method: string;
        params?: [{ fromBlock?: string; toBlock?: string }];
      };
      const reply = (body: object) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }));
      };

      if (request.method !== 'eth_getLogs') {
        reply({ result: '0x7a69' });
        return;
      }

      const { fromBlock, toBlock } = request.params![0];
      logRanges.push(`${fromBlock}-${toBlock}`);
      if (opts.failLogsRequestsAfter !== undefined && logRanges.length > opts.failLogsRequestsAfter) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'endpoint down' }));
        return;
      }

      const [from, to] = [BigInt(fromBlock!), BigInt(toBlock!)];
      if (to - from + 1n > maxSpan) {
        reply({ error: { code: -32005, message: 'query exceeds max block range' } });
        return;
      }
      reply({
        result: [
          {
            address: '0x0000000000000000000000000000000000000001',
            topics: [],
            data: '0x',
            blockNumber: fromBlock,
            blockHash: `0x${'11'.repeat(32)}`,
            transactionHash: `0x${'22'.repeat(32)}`,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          },
        ],
      });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected L1 test server to listen on a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}`, logRanges };
}

describe('makeL1HttpTransport log range cap', () => {
  let l1Server: Server | undefined;
  const extraServers: Server[] = [];

  afterEach(() => {
    l1Server?.close();
    l1Server = undefined;
    extraServers.splice(0).forEach(server => server.close());
  });

  const getLogsOverRange = async (maxLogsWindowSize: number) => {
    const l1 = await startRangeCappedL1Server(10n);
    l1Server = l1.server;
    const client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([l1.url], { maxLogsWindowSize }),
    });
    return client.getLogs({ fromBlock: 0n, toBlock: 24n });
  };

  it('fails against a provider whose log range cap is below the configured window', async () => {
    await expect(getLogsOverRange(100)).rejects.toThrow('L1 RPC request failed');
  });

  it('splits the range and returns every window when the configured window fits', async () => {
    const logs = await getLogsOverRange(10);
    expect(logs.map(log => log.blockNumber)).toEqual([0n, 10n, 20n]);
  });

  it('sends every window of one split query to a single endpoint', async () => {
    const [primary, secondary] = await Promise.all([startRangeCappedL1Server(10n), startRangeCappedL1Server(10n)]);
    extraServers.push(primary.server, secondary.server);
    const client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([primary.url, secondary.url], { maxLogsWindowSize: 10 }),
    });

    await client.getLogs({ fromBlock: 0n, toBlock: 24n });

    expect(primary.logRanges).toEqual(['0x0-0x9', '0xa-0x13', '0x14-0x18']);
    expect(secondary.logRanges).toEqual([]);
  });

  it('retries the whole split query on the next endpoint when one window fails', async () => {
    const [primary, secondary] = await Promise.all([
      startRangeCappedL1Server(10n, { failLogsRequestsAfter: 1 }),
      startRangeCappedL1Server(10n),
    ]);
    extraServers.push(primary.server, secondary.server);
    const client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([primary.url, secondary.url], { maxLogsWindowSize: 10 }),
    });

    const logs = await client.getLogs({ fromBlock: 0n, toBlock: 24n });

    // Every window is answered by the endpoint that is up, so no window of the failed attempt reaches the result.
    expect(logs.map(log => log.blockNumber)).toEqual([0n, 10n, 20n]);
    expect(secondary.logRanges).toEqual(['0x0-0x9', '0xa-0x13', '0x14-0x18']);
  });
});
