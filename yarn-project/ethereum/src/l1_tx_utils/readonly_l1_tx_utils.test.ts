import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { type HttpTransport, createPublicClient, fallback, http, toHex } from 'viem';
import { foundry } from 'viem/chains';

import { ReadOnlyL1TxUtils } from './readonly_l1_tx_utils.js';

/** A single simulated call as an L1 node reports it over eth_simulateV1. */
type RpcCallResult = { gasUsed: bigint; maxUsedGas?: unknown; returnData: `0x${string}` };

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

  it.each([
    { label: 'a non-quantity string', maxUsedGas: 'lots' },
    { label: 'a decimal string', maxUsedGas: '400000' },
    { label: 'a negative number', maxUsedGas: -1 },
    { label: 'an object', maxUsedGas: { value: '0x1' } },
  ])('ignores a maxUsedGas reported as $label', async ({ maxUsedGas }) => {
    const utils = makeUtils(() =>
      Promise.resolve(jsonResponse(rpcResponse(300_000n, { gasUsed: 400_000n, maxUsedGas, returnData: '0x1234' }))),
    );

    await expect(utils.simulate({ to, data: '0x' })).resolves.toEqual({
      gasUsed: 400_000n,
      maxUsedGas: undefined,
      result: '0x1234',
    });
  });

  it('keeps concurrent simulations from reading each other maxUsedGas', async () => {
    // The slow call is held until the fast one has already answered, so a shared capture buffer would
    // hand the slow simulation the fast one's gas figures.
    const slowResponseGate = promiseWithResolvers<void>();
    const utils = makeUtils(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      const data = body.params[0].blockStateCalls[0].calls[0].data;
      if (data === '0x5107') {
        await slowResponseGate.promise;
        return jsonResponse(rpcResponse(1n, { gasUsed: 11_000n, maxUsedGas: toHex(12_000n), returnData: '0x5107' }));
      }
      return jsonResponse(rpcResponse(2n, { gasUsed: 21_000n, maxUsedGas: toHex(22_000n), returnData: '0xfa57' }));
    });

    const slow = utils.simulate({ to, data: '0x5107' });
    const fast = await utils.simulate({ to, data: '0xfa57' });
    slowResponseGate.resolve();

    expect(fast).toEqual({ gasUsed: 21_000n, maxUsedGas: 22_000n, result: '0xfa57' });
    await expect(slow).resolves.toEqual({ gasUsed: 11_000n, maxUsedGas: 12_000n, result: '0x5107' });
  });
});
