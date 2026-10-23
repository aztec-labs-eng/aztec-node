import { startHttpRpcServer } from '@aztec-labs/foundation/json-rpc/server';
import { getErrorCause } from '@aztec-labs/foundation/types';
import { type Server, createServer } from 'node:http';
import { BlockNotFoundError, TransactionReceiptNotFoundError, createPublicClient } from 'viem';
import { foundry, sepolia } from 'viem/chains';

import {
  L1RpcError,
  L1RpcNullResultError,
  createExtendedL1Client,
  getL1RpcErrorCode,
  getL1RpcHttpStatus,
  getRpcUrlsFromClient,
  isL1RpcHttpStatus,
  makeL1HttpTransport,
} from './client.js';
import { type RecordingRpcServer, startRecordingRpcServer } from './test/recording_rpc_server.js';

describe('createExtendedL1Client polling', () => {
  const privateKey = `0x${'01'.repeat(32)}`;
  const rpcUrls = ['http://127.0.0.1:8545'];

  it('defaults to short polling on Anvil', () => {
    expect(createExtendedL1Client(rpcUrls, privateKey, foundry).pollingInterval).toBe(100);
  });

  it('preserves explicit polling intervals, including zero', () => {
    expect(createExtendedL1Client(rpcUrls, privateKey, foundry, 250).pollingInterval).toBe(250);
    expect(createExtendedL1Client(rpcUrls, privateKey, foundry, 0).pollingInterval).toBe(0);
  });

  it('preserves the public-chain default', () => {
    expect(createExtendedL1Client(rpcUrls, privateKey, sepolia).pollingInterval).toBe(4000);
  });
});

async function startRateLimitedL1Server(opts: { jsonRpcBody: boolean }): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    if (opts.jsonRpcBody) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }));
    } else {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('Too Many Requests');
    }
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

  const getChainIdError = async (jsonRpcBody: boolean) => {
    const l1 = await startRateLimitedL1Server({ jsonRpcBody });
    l1Server = l1.server;
    const l1Client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([l1.url]),
    });

    try {
      await l1Client.getChainId();
    } catch (err) {
      return err;
    }
    throw new Error('Expected getChainId to fail');
  };

  it('wraps transport errors while preserving the HTTP status in the cause chain', async () => {
    const error = await getChainIdError(false);

    expect(error).toBeInstanceOf(L1RpcError);
    expect(error).toMatchObject({ message: 'L1 RPC request failed' });
    expect(String(error)).toEqual('L1RpcError: L1 RPC request failed');
    expect(getL1RpcHttpStatus(error)).toBe(429);
    expect(isL1RpcHttpStatus(error, 429)).toBe(true);
  });

  it('surfaces the JSON-RPC error code when a non-2xx response carries a JSON-RPC error body', async () => {
    const error = await getChainIdError(true);

    expect(error).toBeInstanceOf(L1RpcError);
    expect(getL1RpcErrorCode(error)).toBe(-32005);
    expect(getL1RpcHttpStatus(error)).toBeUndefined();
  });
});

describe('makeL1HttpTransport with an RPC that answers null', () => {
  const block = { number: '0x10', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] };
  const answers = new Map<string, unknown>([
    ['eth_getBlockByNumber', block],
    ['eth_getTransactionCount', '0x5'],
    ['eth_call', '0x01'],
    ['debug_traceTransaction', { type: 'CALL' }],
  ]);

  let servers: RecordingRpcServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => server.close()));
    servers = [];
  });

  const startServers = async (opts: { secondAnswersNull?: boolean } = {}) => {
    const nullServer = await startRecordingRpcServer({ answer: () => null });
    const otherServer = await startRecordingRpcServer({
      answer: method => (opts.secondAnswersNull ? null : answers.get(method)),
    });
    servers.push(nullServer, otherServer);
    const client = createPublicClient({
      chain: foundry,
      transport: makeL1HttpTransport([nullServer.url, otherServer.url]),
    });
    return { client, nullServer, otherServer };
  };

  type Client = Awaited<ReturnType<typeof startServers>>['client'];
  const txHash = `0x${'22'.repeat(32)}` as const;

  it('fails over to the next URL when the latest block is null', async () => {
    const { client, otherServer } = await startServers();

    const latest = await client.getBlock();

    expect(latest.number).toBe(16n);
    expect(otherServer.methods).toEqual(['eth_getBlockByNumber']);
  });

  it.each<[string, (client: Client) => Promise<unknown>, unknown]>([
    ['the finalized block', client => client.getBlock({ blockTag: 'finalized' }).then(b => b.number), 16n],
    ['getTransactionCount', client => client.getTransactionCount({ address: `0x${'33'.repeat(20)}` }), 5],
    ['eth_call', client => client.call({ to: `0x${'33'.repeat(20)}`, data: '0x' }).then(r => r.data), '0x01'],
    [
      'debug_traceTransaction with the call tracer',
      client =>
        client.request({ method: 'debug_traceTransaction', params: [txHash, { tracer: 'callTracer' }] } as never),
      { type: 'CALL' },
    ],
  ])('fails over to the next URL when %s returns null', async (_name, call, expected) => {
    const { client, otherServer } = await startServers();

    await expect(call(client)).resolves.toEqual(expected);
    expect(otherServer.methods).toHaveLength(1);
  });

  it.each<[string, (client: Client) => Promise<unknown>, new (...args: any[]) => Error]>([
    ['a block by number', client => client.getBlock({ blockNumber: 16n }), BlockNotFoundError],
    ['the pending block', client => client.getBlock({ blockTag: 'pending' }), BlockNotFoundError],
    [
      'a transaction receipt',
      client => client.getTransactionReceipt({ hash: txHash }),
      TransactionReceiptNotFoundError,
    ],
  ])('does not fail over when %s is null', async (_name, call, notFoundError) => {
    const { client, otherServer } = await startServers();

    await expect(call(client)).rejects.toThrow(notFoundError);
    expect(otherServer.methods).toEqual([]);
  });

  it('does not fail over when a custom tracer returns null', async () => {
    const { client, otherServer } = await startServers();

    const trace = await client.request({
      method: 'debug_traceTransaction',
      params: [txHash, { tracer: '{ result: function() { return null; } }' }],
    } as never);

    expect(trace).toBeNull();
    expect(otherServer.methods).toEqual([]);
  });

  it('rejects with an L1RpcError after retrying when every URL returns null', async () => {
    const { client, nullServer, otherServer } = await startServers({ secondAnswersNull: true });

    const error = await client.getBlock().catch(err => err);

    expect(error).toBeInstanceOf(L1RpcError);
    expect(getErrorCause(error, L1RpcNullResultError)).toBeDefined();
    expect(nullServer.methods.length).toBeGreaterThan(1);
    expect(otherServer.methods.length).toBeGreaterThan(1);
    for (const err of [error, getErrorCause(error, L1RpcNullResultError)]) {
      expect(err.message).not.toContain('127.0.0.1');
    }
  });

  it('keeps every URL visible to getRpcUrlsFromClient', async () => {
    const { client, nullServer, otherServer } = await startServers();

    expect(getRpcUrlsFromClient(client)).toEqual([nullServer.url, otherServer.url]);
  });
});
