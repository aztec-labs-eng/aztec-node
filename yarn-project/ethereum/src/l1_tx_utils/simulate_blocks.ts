import {
  type SimulateBlocksParameters,
  type SimulateBlocksReturnType,
  simulateBlocks as viemSimulateBlocks,
} from 'viem/actions';
import { z } from 'zod';

import type { ViemClient } from '../types.js';

/**
 * A simulated call result as formatted by viem, plus the optional per-call `maxUsedGas` that viem's
 * formatter drops.
 *
 * `maxUsedGas` is the gas the node reports the call as having used before refunds were applied (see
 * EIP-7778). It is optional: nodes are not required to report it, and it is not a guarantee that a
 * transaction sent with that gas limit will succeed, so callers still pad it.
 *
 * Exported only so the package's declaration output can name it; it is not part of the package API.
 */
export type SimulatedCall = SimulateBlocksReturnType[number]['calls'][number] & { maxUsedGas?: bigint };

/** A simulated block as formatted by viem, with per-call results augmented with {@link SimulatedCall}. */
export type SimulatedBlock = Omit<SimulateBlocksReturnType[number], 'calls'> & { calls: SimulatedCall[] };

/** A JSON-RPC quantity, which nodes encode as a 0x-prefixed hex string. */
const rpcQuantitySchema = z
  .string()
  .regex(/^0x[0-9a-f]+$/i, 'Not a JSON-RPC quantity')
  .transform(quantity => BigInt(quantity));

/**
 * The only part of a raw eth_simulateV1 response this module reads: the optional per-call `maxUsedGas`.
 * A `maxUsedGas` the node reports in some other shape is treated as not reported, so an unexpected
 * encoding costs us headroom rather than breaking the simulation. An explicit `0` is a reported value.
 */
const simulateV1MaxUsedGasSchema = z.array(
  z.object({ calls: z.array(z.object({ maxUsedGas: rpcQuantitySchema.optional().catch(undefined) })) }),
);

/** The `request` signature of a viem client, narrowed to what the capture wrapper needs. */
type RawRequestFn = (args: { method: string; params?: unknown }, options?: unknown) => Promise<unknown>;

/**
 * Runs `eth_simulateV1` through viem's `simulateBlocks` action, retaining the optional per-call
 * `maxUsedGas` field that viem's result formatter discards.
 *
 * The raw JSON-RPC response is captured through a per-invocation client wrapper that delegates to the
 * original `request` (so the client's transport, its fallbacks and its error wrapping are all
 * preserved) and is then merged into the formatted call results. The wrapper is local to this call, so
 * concurrent simulations never observe each other's responses.
 */
export async function simulateBlocksWithMaxUsedGas(
  client: ViemClient,
  params: SimulateBlocksParameters,
): Promise<SimulatedBlock[]> {
  let rawResponse: unknown;
  // `request` is generic over the client's RPC schema, so it cannot be implemented by a plain function;
  // the two casts are confined to this boundary and the captured response is validated below.
  const baseRequest = client.request as RawRequestFn;
  const capturingRequest: RawRequestFn = async (args, options) => {
    const response = await baseRequest(args, options);
    if (args.method === 'eth_simulateV1') {
      rawResponse = response;
    }
    return response;
  };

  const capturingClient = { ...client, request: capturingRequest as typeof client.request };
  const blocks = await viemSimulateBlocks(capturingClient, params);

  const maxUsedGas = parseMaxUsedGas(rawResponse);
  return blocks.map((block, blockIndex) => ({
    ...block,
    calls: block.calls.map((call, callIndex) => ({ ...call, maxUsedGas: maxUsedGas[blockIndex]?.[callIndex] })),
  }));
}

/** Extracts the optional `maxUsedGas` of every call of every block from a raw eth_simulateV1 response. */
function parseMaxUsedGas(response: unknown): (bigint | undefined)[][] {
  const parsed = simulateV1MaxUsedGasSchema.safeParse(response);
  return parsed.success ? parsed.data.map(block => block.calls.map(call => call.maxUsedGas)) : [];
}
