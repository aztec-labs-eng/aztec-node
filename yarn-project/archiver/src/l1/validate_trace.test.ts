import type { ViemPublicDebugClient } from '@aztec-labs/ethereum/types';
import { jest } from '@jest/globals';
import { type Hex, createPublicClient, fallback, http } from 'viem';
import { foundry } from 'viem/chains';

import { getArchiverConfigFromEnv } from '../config.js';
import { validateAndLogTraceAvailability } from './validate_trace.js';

type TraceMethod = 'debug_traceTransaction' | 'trace_transaction';

/**
 * Builds a debug client over a fake L1 JSON-RPC endpoint whose blocks hold the given txs and that serves the given
 * trace methods. The endpoint is served by mocking fetch, so the client is built like the archiver's.
 */
function makeDebugClient(opts: { blockTxs: Hex[]; traceMethods: TraceMethod[]; unreachable?: boolean }) {
  const respond = (id: number, body: { result: unknown } | { error: { code: number; message: string } }) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), { headers: { 'Content-Type': 'application/json' } });

  jest.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
    if (opts.unreachable) {
      return Promise.reject(new Error('connection refused'));
    }
    const { id, method, params } = JSON.parse(init!.body as string) as { id: number; method: string; params: string[] };
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'latest' ? '0x64' : params[0];
      return Promise.resolve(respond(id, { result: { number, transactions: opts.blockTxs } }));
    }
    if (!opts.traceMethods.includes(method as TraceMethod)) {
      return Promise.resolve(respond(id, { error: { code: -32601, message: `the method ${method} does not exist` } }));
    }
    const trace = method === 'debug_traceTransaction' ? { from: `0x${'01'.repeat(20)}`, type: 'CALL' } : [];
    return Promise.resolve(respond(id, { result: trace }));
  });

  return createPublicClient({
    chain: foundry,
    transport: fallback([http('http://fake-debug-host:8545', { batch: false, retryCount: 0 })], { retryCount: 0 }),
  }) as ViemPublicDebugClient;
}

describe('validateAndLogTraceAvailability', () => {
  const txHash: Hex = `0x${'ab'.repeat(32)}`;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ETHEREUM_ALLOW_NO_DEBUG_HOSTS;
    delete process.env.ETHEREUM_ALLOW_NO_DEBUG_HOSTS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedEnv === undefined) {
      delete process.env.ETHEREUM_ALLOW_NO_DEBUG_HOSTS;
    } else {
      process.env.ETHEREUM_ALLOW_NO_DEBUG_HOSTS = savedEnv;
    }
  });

  it('requires a trace-capable endpoint by default', () => {
    expect(getArchiverConfigFromEnv().ethereumAllowNoDebugHosts).toBe(false);
  });

  it('refuses to start by default when the endpoint serves neither trace method', async () => {
    const client = makeDebugClient({ blockTxs: [txHash], traceMethods: [] });
    const { ethereumAllowNoDebugHosts } = getArchiverConfigFromEnv();

    await expect(validateAndLogTraceAvailability(client, ethereumAllowNoDebugHosts ?? false)).rejects.toThrow(
      /ETHEREUM_ALLOW_NO_DEBUG_HOSTS=true/,
    );
  });

  it('starts when the operator opts out with ETHEREUM_ALLOW_NO_DEBUG_HOSTS=true', async () => {
    process.env.ETHEREUM_ALLOW_NO_DEBUG_HOSTS = 'true';
    const client = makeDebugClient({ blockTxs: [txHash], traceMethods: [] });
    const { ethereumAllowNoDebugHosts } = getArchiverConfigFromEnv();

    await expect(validateAndLogTraceAvailability(client, ethereumAllowNoDebugHosts ?? false)).resolves.toBeUndefined();
  });

  it.each<TraceMethod>(['debug_traceTransaction', 'trace_transaction'])(
    'starts when the endpoint serves %s',
    async method => {
      const client = makeDebugClient({ blockTxs: [txHash], traceMethods: [method] });
      await expect(validateAndLogTraceAvailability(client, false)).resolves.toBeUndefined();
    },
  );

  it('starts when no recent block has a transaction to probe with', async () => {
    const client = makeDebugClient({ blockTxs: [], traceMethods: [] });
    await expect(validateAndLogTraceAvailability(client, false)).resolves.toBeUndefined();
  });

  it('refuses to start when the endpoint cannot be reached', async () => {
    const client = makeDebugClient({ blockTxs: [txHash], traceMethods: [], unreachable: true });
    await expect(validateAndLogTraceAvailability(client, false)).rejects.toThrow(/ETHEREUM_ALLOW_NO_DEBUG_HOSTS/);
  });
});
