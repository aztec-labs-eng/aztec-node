import { createLogger } from '@aztec-labs/foundation/log';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { type HttpTransport, createPublicClient, fallback, http, toHex } from 'viem';
import { foundry } from 'viem/chains';

import { ReadOnlyL1TxUtils } from './readonly_l1_tx_utils.js';

/** A single simulated call as an L1 node reports it over eth_simulateV1. */
type RpcCallResult = { gasUsed: bigint; maxUsedGas?: `0x${string}`; returnData: `0x${string}` };

describe('ReadOnlyL1TxUtils simulation gas accounting', () => {
  const to = '0x1234567890123456789012345678901234567890';
  const logger = createLogger('ethereum:test:simulation-gas');

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

  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  /** A real viem client whose only mocked part is the HTTP transport, so RPC formatting runs for real. */
  const makeUtils = (fetchFn: (url: string, init: RequestInit) => Promise<Response>) => {
    const transports: HttpTransport[] = [http('http://l1.test', { fetchFn: fetchFn as typeof fetch })];
    const client = createPublicClient({ chain: foundry, transport: fallback(transports) });
    return new ReadOnlyL1TxUtils(client, logger, new DateProvider());
  };

  it.each([
    { maxUsedGas: 500_000n, expectedMaxUsedGas: 500_000n },
    { maxUsedGas: undefined, expectedMaxUsedGas: undefined },
    { maxUsedGas: 0n, expectedMaxUsedGas: 0n },
  ])(
    'preserves per-call gas and optional maxUsedGas=$maxUsedGas from the RPC',
    async ({ maxUsedGas, expectedMaxUsedGas }) => {
      const utils = makeUtils(() =>
        Promise.resolve(
          jsonResponse(
            rpcResponse(300_000n, {
              gasUsed: 400_000n,
              maxUsedGas: maxUsedGas === undefined ? undefined : toHex(maxUsedGas),
              returnData: '0x1234',
            }),
          ),
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
