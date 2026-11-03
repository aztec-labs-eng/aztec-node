import type { DebugCallTrace, ViemPublicDebugClient } from '@aztec-labs/ethereum/types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import { type ZodFor, schemas } from '@aztec-labs/foundation/schemas';
import { withHexPrefix } from '@aztec-labs/foundation/string';
import type { Hex } from 'viem';
import { z } from 'zod';

import { type CallInfo, MAX_L1_TRACE_LEN } from './types.js';

/** The EVM stops nesting calls 1024 frames below the top-level call. */
const EVM_MAX_CALL_DEPTH = 1024;

/** A single frame of a call trace. Its `calls` are left unparsed, and {@link callTraceSchema} parses each of them. */
export const callFrameSchema = z.object({
  from: schemas.HexStringWith0x,
  to: schemas.HexStringWith0x.optional(),
  type: z.string(),
  input: schemas.HexStringWith0x.optional(),
  output: schemas.HexStringWith0x.optional(),
  gas: schemas.HexStringWith0x.optional(),
  gasUsed: schemas.HexStringWith0x.optional(),
  value: schemas.HexStringWith0x.optional(),
  error: z.string().optional(),
  calls: z.array(z.unknown()).max(MAX_L1_TRACE_LEN).optional(),
});

/** A frame waiting to be parsed, with what is needed to attach it to its parent and to locate it in an error. */
type PendingFrame = {
  input: unknown;
  depth: number;
  parent?: { frame: PendingFrame; index: number };
  attach: (frame: DebugCallTrace) => void;
};

/**
 * Zod schema for validating call trace from debug_traceTransaction.
 *
 * A trace nests one frame per EVM call, and the EVM allows 1024 calls below the top-level one. A recursive schema
 * (`z.lazy`) would use several JS stack frames per call: in Node with its default stack size, zod overflows the stack
 * after a few hundred calls, well short of the EVM limit. So this schema parses one frame at a time from an explicit
 * stack, and rejects a trace that nests deeper than the EVM can.
 */
export const callTraceSchema: ZodFor<DebugCallTrace> = z.unknown().transform((input, ctx) => {
  let root: DebugCallTrace | undefined;
  const pending: PendingFrame[] = [{ input, depth: 0, attach: frame => (root = frame) }];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.depth > EVM_MAX_CALL_DEPTH) {
      ctx.addIssue({ code: 'custom', message: `Calls nested deeper than ${EVM_MAX_CALL_DEPTH}`, path: pathOf(next) });
      return z.NEVER;
    }
    const parsed = callFrameSchema.safeParse(next.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: 'custom', message: issue.message, path: [...pathOf(next), ...issue.path] });
      }
      return z.NEVER;
    }

    const { calls, ...fields } = parsed.data;
    const frame: DebugCallTrace = fields;
    if (calls !== undefined) {
      const children: DebugCallTrace[] = new Array(calls.length);
      frame.calls = children;
      const current = next;
      calls.forEach((child, index) =>
        pending.push({
          input: child,
          depth: current.depth + 1,
          parent: { frame: current, index },
          attach: parsedChild => (children[index] = parsedChild),
        }),
      );
    }
    next.attach(frame);
  }

  return root!;
});

/** Path of a frame from the root of the trace, built only when reporting an issue. */
function pathOf(frame: PendingFrame): PropertyKey[] {
  const path: PropertyKey[] = [];
  for (let current = frame; current.parent; current = current.parent.frame) {
    path.unshift('calls', current.parent.index);
  }
  return path;
}

/**
 * Traces a transaction and extracts all CALL operations to a specific contract and function selector.
 *
 * @param client - The Viem public client
 * @param txHash - The transaction hash to trace
 * @param targetAddress - The contract address to filter for
 * @param functionSelector - The 4-byte function selector to filter for (with or without 0x prefix)
 * @returns Array of CallInfo objects containing from, gasUsed, input, and value for matching calls
 */
export async function getSuccessfulCallsFromDebug(
  client: ViemPublicDebugClient,
  txHash: Hex,
  targetAddress: EthAddress,
  functionSelector: string,
  logger?: Logger,
): Promise<CallInfo[]> {
  // Normalize inputs for comparison
  const normalizedTarget = targetAddress.toString().toLowerCase();
  const normalizedSelector = withHexPrefix(functionSelector.toLowerCase());

  // Call debug_traceTransaction with callTracer
  // Using 'any' here because debug_traceTransaction is not in viem's standard RPC types
  const rawTrace = await client.request({
    method: 'debug_traceTransaction',
    params: [txHash, { tracer: 'callTracer' }],
  });

  if (rawTrace === null || rawTrace === undefined) {
    throw new Error(`Failed to retrieve debug_traceTransaction for ${txHash}`);
  }

  logger?.trace(`Retrieved debug_traceTransaction for ${txHash}`, { trace: rawTrace });

  // Validate the response with zod
  const trace = callTraceSchema.parse(rawTrace);

  const results: CallInfo[] = [];

  /**
   * Recursively traverse the call trace tree
   */
  function traverseCalls(callTrace: DebugCallTrace) {
    // Skip calls that have errors, and all its descendants
    if (callTrace.error) {
      return;
    }

    // Check if this is a CALL (not DELEGATECALL or STATICCALL) to the target address with matching selector
    if (
      callTrace.type.toUpperCase() === 'CALL' &&
      callTrace.to?.toLowerCase() === normalizedTarget &&
      callTrace.input?.toLowerCase().startsWith(normalizedSelector)
    ) {
      results.push({
        from: EthAddress.fromString(callTrace.from),
        gasUsed: callTrace.gasUsed === undefined ? undefined : BigInt(callTrace.gasUsed),
        input: callTrace.input,
        value: callTrace.value ? BigInt(callTrace.value) : 0n,
      });
    }

    // Recursively process nested calls
    for (const nestedCall of callTrace.calls ?? []) {
      traverseCalls(nestedCall);
    }
  }

  // Start traversal from the root trace
  traverseCalls(trace);

  return results;
}
