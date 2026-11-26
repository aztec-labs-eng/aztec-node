import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { type HttpTransport, createPublicClient, fallback, http, toHex } from 'viem';
import { foundry } from 'viem/chains';

import { ReadOnlyL1TxUtils } from './readonly_l1_tx_utils.js';

/** A single simulated call as an L1 node reports it over eth_simulateV1. */
type RpcCallResult = { gasUsed: bigint; maxUsedGas?: `0x${string}`; returnData: `0x${string}` };

const logger = createLogger('ethereum:test:readonly-l1-utils');
const jsonResponse = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));

/** A real viem client whose only mocked part is the HTTP transport, so RPC formatting runs for real. */
const makeUtils = (fetchFn: (url: string, init: RequestInit) => Promise<Response>) => {
  const transports: HttpTransport[] = [http('http://l1.test', { fetchFn: fetchFn as typeof fetch })];
  const client = createPublicClient({ chain: foundry, transport: fallback(transports) });
  return new ReadOnlyL1TxUtils(client, logger, new DateProvider());
};

describe('ReadOnlyL1TxUtils fee quote', () => {
  it('uses mined tips, not a pending spike alone, to flag an underbid without raising the bid', async () => {
    const lowTip = 5000n;
    const highTip = 500_000_000n;
    const quoteWithHistory = (tips: bigint[]) =>
      makeUtils((_url, init) => {
        if (typeof init.body !== 'string') {
          throw new Error('Expected a JSON string RPC request body');
        }
        const { method, params } = JSON.parse(init.body);
        switch (method) {
          case 'eth_getBlockByNumber':
            return jsonResponse({
              jsonrpc: '2.0',
              id: 1,
              result: {
                number: '0x64',
                baseFeePerGas: '0x100',
                transactions: params[0] === 'pending' ? [{ type: '0x2', maxPriorityFeePerGas: toHex(highTip) }] : [],
              },
            });
          case 'eth_maxPriorityFeePerGas':
            return jsonResponse({ jsonrpc: '2.0', id: 1, result: toHex(lowTip) });
          case 'eth_feeHistory':
            return jsonResponse({
              jsonrpc: '2.0',
              id: 1,
              result: {
                oldestBlock: '0x60',
                baseFeePerGas: Array(tips.length + 1).fill('0x100'),
                gasUsedRatio: tips.map(() => 0.5),
                reward: tips.map(tip => [toHex(tip)]),
              },
            });
          default:
            throw new Error(`Unexpected RPC method: ${method}`);
        }
      }).getFeeQuote();

    const pendingOnly = await quoteWithHistory(Array(5).fill(lowTip));
    const sustained = await quoteWithHistory([lowTip, highTip, highTip, highTip, lowTip]);

    expect(pendingOnly.competitiveTip).toBeLessThanOrEqual(pendingOnly.bid.maxPriorityFeePerGas);
    expect(sustained.competitiveTip).toBe(highTip);
    expect(sustained.bid.maxPriorityFeePerGas).toBeLessThan(highTip);
    expect(sustained.bid).toEqual(pendingOnly.bid);
  });
});

describe('ReadOnlyL1TxUtils simulation gas accounting', () => {
  const to = '0x1234567890123456789012345678901234567890';

  /** Builds an eth_simulateV1 response whose block gas deliberately differs from the call gas. */
  const rpcResponse = (blockGasUsed: bigint, call: RpcCallResult) => ({
    jsonrpc: '2.0',
    id: 1,
    result: [
      {
        gasUsed: toHex(blockGasUsed),
        calls: [
          {
            status: '0x1',
            returnData: call.returnData,
            gasUsed: toHex(call.gasUsed),
            ...(call.maxUsedGas !== undefined ? { maxUsedGas: call.maxUsedGas } : {}),
            logs: [],
          },
        ],
      },
    ],
  });

  it.each([
    { maxUsedGas: 500_000n, expectedMaxUsedGas: 500_000n },
    { maxUsedGas: undefined, expectedMaxUsedGas: undefined },
    { maxUsedGas: 0n, expectedMaxUsedGas: 0n },
  ])(
    'preserves per-call gas and optional maxUsedGas=$maxUsedGas from the RPC',
    async ({ maxUsedGas, expectedMaxUsedGas }) => {
      const utils = makeUtils(() =>
        jsonResponse(
          rpcResponse(300_000n, {
            gasUsed: 400_000n,
            maxUsedGas: maxUsedGas === undefined ? undefined : toHex(maxUsedGas),
            returnData: '0x1234',
          }),
        ),
      );

      await expect(utils.simulate({ to, data: '0x' })).resolves.toEqual({
        gasUsed: 400_000n,
        maxUsedGas: expectedMaxUsedGas,
        result: '0x1234',
      });
    },
  );
});
