import { createLogger } from '@aztec-labs/foundation/log';
import type { FallbackTransport, HttpTransport } from 'viem';
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
  blockHash?: string;
  fromBlock?: string;
  toBlock?: string;
};

/**
 * Whether a request parameter is a filter whose bounds this cap can read. A bound that is not a string is one this
 * cap has no opinion on, so the filter goes to the provider exactly as the caller wrote it.
 */
function isLogsFilter(value: unknown): value is LogsFilter {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { blockHash, fromBlock, toBlock } = value as Record<string, unknown>;
  const isBound = (bound: unknown) => bound === undefined || typeof bound === 'string';
  return isBound(blockHash) && isBound(fromBlock) && isBound(toBlock);
}

/** Block tags whose height changes as the chain grows, so a bound naming one has to be resolved before chunking. */
const MOVING_BLOCK_TAGS: readonly string[] = ['latest', 'safe', 'finalized'];

/** Block tags this cap can turn into a height. Anything else (`pending`) leaves the bound unknown. */
const RESOLVABLE_BLOCK_TAGS: readonly string[] = [...MOVING_BLOCK_TAGS, 'earliest'];

/**
 * The cap to apply when the caller supplies none: `MAX_L1_LOGS_WINDOW_SIZE` if the environment sets it, else
 * {@link DEFAULT_MAX_L1_LOGS_WINDOW_SIZE}. Entry points that parse a config thread the value explicitly, but clients
 * built without one -- a CLI command, the per-URL probes the archiver makes at startup -- reach the environment here
 * rather than silently falling back to the default.
 */
export function configuredMaxL1LogsWindowSize(): number {
  const fromEnv = process.env.MAX_L1_LOGS_WINDOW_SIZE;
  if (fromEnv === undefined || fromEnv.trim() === '') {
    return DEFAULT_MAX_L1_LOGS_WINDOW_SIZE;
  }
  const parsed = Number(fromEnv);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`MAX_L1_LOGS_WINDOW_SIZE must be a positive integer, got ${fromEnv}`);
  }
  return parsed;
}

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
function tagOf(bound: string | undefined): string | undefined {
  if (bound === undefined) {
    return 'latest';
  }
  return bound.startsWith('0x') ? undefined : bound;
}

/** The height a `0x`-prefixed bound names, or undefined when it is not a quantity the provider would accept. */
function parseBlockHeight(bound: string): bigint | undefined {
  try {
    return BigInt(bound);
  } catch {
    return undefined;
  }
}

/** Issues a request on the transport being wrapped. */
type RequestFn = (args: { method: string; params?: unknown }) => Promise<unknown>;

/**
 * The block heights a filter's bounds denote, resolving any moving tag against the chain. Returns undefined when the
 * range is not one this cap can split: a `pending` bound has no canonical height, a tag the provider cannot answer
 * (`finalized` on a chain that has none yet) leaves the bound unknown, and an inverted range is left for the
 * provider to reject as it would have without the cap. A resolution request that fails also yields undefined -- the
 * probe this cap adds must never fail a query the provider would have answered.
 */
async function resolveLogsWindow(
  filter: LogsFilter,
  request: RequestFn,
): Promise<{ fromBlock: bigint; toBlock: bigint } | undefined> {
  const fromTag = tagOf(filter.fromBlock);
  const toTag = tagOf(filter.toBlock);

  const unresolvable = (tag: string | undefined) => tag !== undefined && !RESOLVABLE_BLOCK_TAGS.includes(tag);
  if (unresolvable(fromTag) || unresolvable(toTag)) {
    return undefined;
  }

  // Both bounds naming the same moving tag span a single block, whatever height it currently sits at.
  if (fromTag !== undefined && fromTag === toTag && MOVING_BLOCK_TAGS.includes(fromTag)) {
    return undefined;
  }

  const resolved = new Map<string, bigint | undefined>();
  const resolve = async (bound: string | undefined, tag: string | undefined) => {
    if (typeof bound === 'string' && tag === undefined) {
      return parseBlockHeight(bound);
    }
    if (tag === 'earliest') {
      return 0n;
    }
    if (tag === undefined) {
      return undefined;
    }
    if (!resolved.has(tag)) {
      resolved.set(tag, await resolveTagHeight(tag, request));
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

/** The height a moving tag currently names, or undefined when the provider cannot or will not say. */
async function resolveTagHeight(tag: string, request: RequestFn): Promise<bigint | undefined> {
  try {
    const block = await request({ method: 'eth_getBlockByNumber', params: [tag, false] });
    if (typeof block !== 'object' || block === null) {
      return undefined;
    }
    const { number } = block as Record<string, unknown>;
    return typeof number === 'string' ? parseBlockHeight(number) : undefined;
  } catch (err) {
    logger.debug(`Could not resolve L1 block tag to cap an eth_getLogs range`, { tag, err });
    return undefined;
  }
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

      const filter = Array.isArray(args.params) ? (args.params[0] as unknown) : undefined;
      // A by-hash filter names a single block, and one this cap cannot read is the provider's to interpret.
      if (!isLogsFilter(filter) || filter.blockHash !== undefined) {
        return forward(args);
      }

      const window = await resolveLogsWindow(filter, forward);
      if (window === undefined) {
        return forward(args);
      }

      const windows = splitLogsWindow(window.fromBlock, window.toBlock, maxWindowSize);
      const requestWindow = ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        forward({ ...args, params: [{ ...filter, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }] });

      // Send the resolved heights rather than the bounds as written, even for a single window: a `latest` left in
      // place is re-read by the provider, and a block mined since it was resolved puts the range back over the cap.
      if (windows.length === 1) {
        return requestWindow(windows[0]);
      }

      logger.debug(`Splitting eth_getLogs into ${windows.length} requests`, {
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        windowCount: windows.length,
        maxWindowSize,
      });
      const logs: unknown[] = [];
      for (const currentWindow of windows) {
        const windowLogs = await requestWindow(currentWindow);
        if (!Array.isArray(windowLogs)) {
          throw new Error(`Expected an array of logs from eth_getLogs, got ${typeof windowLogs}`);
        }
        // Appended one at a time: spreading a window's logs into `push` passes them as arguments, which overflows
        // the stack on the tens of thousands of logs a block range can hold.
        for (const log of windowLogs) {
          logs.push(log);
        }
      }
      return logs;
    };

    // viem types a transport's `request` as an overload over the RPC schema, which a handler this generic cannot be
    // written against; the cast is what lets one handler serve every method.
    return { ...base, request: handle as typeof base.request };
  };

  return capped;
}
