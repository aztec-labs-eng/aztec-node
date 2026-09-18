import { createLogger } from '@aztec-labs/foundation/log';
import type { BlockTag, FallbackTransport, Hex, HttpTransport } from 'viem';
import { numberToHex } from 'viem';

/**
 * Default ceiling, in L1 blocks, on the span of a single `eth_getLogs` request. Providers impose their own limits
 * and reject anything wider; 10k is permissive enough for the ranges this node asks for and low enough to clear the
 * caps of the endpoints seen in practice. Operators whose provider is stricter lower it with
 * `MAX_L1_LOGS_WINDOW_SIZE`.
 */
export const DEFAULT_MAX_L1_LOGS_WINDOW_SIZE = 10_000;

const logger = createLogger('ethereum:logs_window');

/** The subset of an `eth_getLogs` filter this cap reasons about. */
type LogsFilter = {
  blockHash?: Hex;
  fromBlock?: Hex | BlockTag;
  toBlock?: Hex | BlockTag;
};

/** Block tags whose height changes as the chain grows, so a bound naming one has to be resolved before chunking. */
const MOVING_BLOCK_TAGS: BlockTag[] = ['latest', 'safe', 'finalized'];

/**
 * Splits an inclusive L1 block range into consecutive windows of at most `maxWindowSize` blocks. The windows tile
 * the range with no gap and no overlap, in ascending order.
 */
export function splitLogsWindow(
  fromBlock: bigint,
  toBlock: bigint,
  maxWindowSize: number,
): { fromBlock: bigint; toBlock: bigint }[] {
  const size = BigInt(maxWindowSize);
  const windows: { fromBlock: bigint; toBlock: bigint }[] = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    const end = start + size - 1n;
    windows.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock });
  }
  return windows;
}

/** The tag a bound names, or undefined when it is a block number. An absent bound means `latest`, as in the spec. */
function tagOf(bound: Hex | BlockTag | undefined): BlockTag | undefined {
  if (bound === undefined) {
    return 'latest';
  }
  return bound.startsWith('0x') ? undefined : (bound as BlockTag);
}

/** Issues a request on the transport being wrapped. */
type RequestFn = (args: { method: string; params?: unknown }) => Promise<unknown>;

/**
 * The block heights a filter's bounds denote, resolving any moving tag against the chain. Returns undefined when the
 * range is not one this cap can split: a `pending` bound has no canonical height, a tag the provider cannot answer
 * (`finalized` on a chain that has none yet) leaves the bound unknown, and an inverted range is left for the
 * provider to reject as it would have without the cap.
 */
async function resolveLogsWindow(
  filter: LogsFilter,
  request: RequestFn,
): Promise<{ fromBlock: bigint; toBlock: bigint } | undefined> {
  const fromTag = tagOf(filter.fromBlock);
  const toTag = tagOf(filter.toBlock);

  // Both bounds naming the same moving tag span a single block, whatever height it currently sits at.
  if (fromTag !== undefined && fromTag === toTag && MOVING_BLOCK_TAGS.includes(fromTag)) {
    return undefined;
  }

  const resolved = new Map<BlockTag, bigint | undefined>();
  const resolve = async (bound: Hex | BlockTag | undefined, tag: BlockTag | undefined) => {
    if (tag === undefined) {
      return BigInt(bound as Hex);
    }
    if (tag === 'earliest') {
      return 0n;
    }
    if (!MOVING_BLOCK_TAGS.includes(tag)) {
      return undefined;
    }
    if (!resolved.has(tag)) {
      const block = (await request({ method: 'eth_getBlockByNumber', params: [tag, false] })) as {
        number?: Hex | null;
      } | null;
      const height = block?.number;
      resolved.set(tag, height === undefined || height === null ? undefined : BigInt(height));
    }
    return resolved.get(tag);
  };

  const fromBlock = await resolve(filter.fromBlock, fromTag);
  const toBlock = await resolve(filter.toBlock, toTag);
  if (fromBlock === undefined || toBlock === undefined || fromBlock > toBlock) {
    return undefined;
  }
  return { fromBlock, toBlock };
}

/**
 * Wraps a transport so no `eth_getLogs` request it carries spans more than `maxWindowSize` L1 blocks: a wider range
 * is split into consecutive requests and their logs concatenated. Capping here rather than at each call site means
 * every L1 log query in the system is bounded -- `getLogs`, `getContractEvents` and a contract's `getEvents` all
 * reach the provider through this one point -- and an operator whose provider caps ranges below what a call site
 * asks for does not have to find and configure that call site.
 *
 * The windows are disjoint and ascending, so their concatenation is the list a single request would have returned
 * from one view of the chain. It is several views: a reorg between two windows can yield logs that never coexisted
 * on one chain, exactly as the range chunking that already exists at several call sites can. Consumers that commit
 * results to disk check the L1 blocks they came from, so a split view is caught there rather than here.
 *
 * A window that the provider rejects fails the whole request: a partial prefix of the range must never be reported
 * as the range's logs.
 */
export function capLogsWindow(
  transport: FallbackTransport<HttpTransport[]>,
  maxWindowSize: number,
): FallbackTransport<HttpTransport[]> {
  if (!Number.isSafeInteger(maxWindowSize) || maxWindowSize < 1) {
    throw new Error(`Max L1 logs window size must be a positive integer, got ${maxWindowSize}`);
  }

  const capped: FallbackTransport<HttpTransport[]> = parameters => {
    const base = transport(parameters);
    type Request = Parameters<typeof base.request>[0];
    type RequestOptions = Parameters<typeof base.request>[1];

    const handle = async (args: { method: string; params?: unknown }, options: RequestOptions): Promise<unknown> => {
      const forward: RequestFn = a => base.request(a as Request, options);
      if (args.method !== 'eth_getLogs') {
        return forward(args);
      }

      const filter = (args.params as [LogsFilter] | undefined)?.[0];
      // A by-hash filter names a single block, and a malformed one is the provider's to reject.
      if (filter === undefined || filter.blockHash !== undefined) {
        return forward(args);
      }

      const window = await resolveLogsWindow(filter, forward);
      if (window === undefined) {
        return forward(args);
      }

      const windows = splitLogsWindow(window.fromBlock, window.toBlock, maxWindowSize);
      // Pass the original bounds through untouched when they already fit, so a tag stays a tag.
      if (windows.length <= 1) {
        return forward(args);
      }

      logger.debug(
        `Splitting eth_getLogs over L1 blocks ${window.fromBlock}-${window.toBlock} into ${windows.length} requests of up to ${maxWindowSize} blocks`,
      );
      const logs: unknown[] = [];
      for (const { fromBlock, toBlock } of windows) {
        const params = [{ ...filter, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }];
        logs.push(...((await forward({ ...args, params })) as unknown[]));
      }
      return logs;
    };

    // viem types a transport's `request` as an overload over the RPC schema, which a handler this generic cannot be
    // written against; the cast is what lets one handler serve every method.
    return { ...base, request: handle as typeof base.request };
  };

  return capped;
}
