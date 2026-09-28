import { BadRequestError } from '@aztec-labs/foundation/json-rpc';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { InterruptibleSleep } from '@aztec-labs/foundation/sleep';
import { Timer } from '@aztec-labs/foundation/timer';
import {
  type AnchoredBlockParameter,
  type BlockData,
  type BlockHash,
  type L2Block,
  type L2BlockSource,
  type L2BlockSourceEventEmitter,
  L2BlockSourceEvents,
  type NormalizedBlockParameter,
  getBlockSourceEmitter,
  inspectBlockParameter,
  isAnchoredBlockParameter,
} from '@aztec-labs/stdlib/block';

/**
 * Longest a held request sleeps before re-reading the block source anyway. Held requests are woken by the source
 * reporting an update, so this only bounds how long one waits when it misses the update that added its block: the
 * source can commit between a request's read and its sleep, and a request that is not sleeping yet is not woken.
 */
const MAX_SLEEP_MS = 1000;

/** Max requests held simultaneously. Beyond this, misses fail fast as if the hold-off were disabled. */
export const MAX_CONCURRENT_HOLDS = 100;

/** Wait budgets for {@link UnseenBlockHoldOff}, in milliseconds. Zero (or negative) disables a budget. */
export type UnseenBlockHoldOffConfig = {
  /** Budget for a query anchored on the block number right after the node's proposed tip. */
  byNumberWaitMs: number;
  /** Budget for a query anchored on a block hash or archive root the node does not know. */
  byHashWaitMs: number;
};

/** Options for a single {@link UnseenBlockHoldOff} query. */
export type UnseenBlockHoldOffOptions = {
  /** Set to false to resolve without ever waiting (used by callers that already spent their budget). */
  holdOff?: boolean;
};

/**
 * What {@link UnseenBlockHoldOff} resolves: a query naming a block one way, or an anchor naming it by both its
 * number and its hash. The anchored form stops here — everything below reads the block source by hash alone.
 */
export type HoldOffBlockQuery = NormalizedBlockParameter | AnchoredBlockParameter;

/** A block read the hold-off can check against an anchor: block metadata, or a whole block with its transactions. */
type ReadBlock = BlockData | L2Block;

/** The hash of a block read, taken from metadata where it is carried and computed from the header otherwise. */
function blockHashOf(value: ReadBlock): Promise<BlockHash> {
  return 'blockHash' in value ? Promise.resolve(value.blockHash) : value.hash();
}

/**
 * The single-selector query to read the block source with for `query`: an anchor is looked up by its hash alone.
 *
 * The object is built fresh rather than narrowed, because narrowing is only a promise to the type checker: an object
 * carrying both keys structurally satisfies the single-selector union, and the archiver resolves `number` in
 * preference to `hash`, so an anchor that leaked through would be answered by height and lose the fork its hash pins.
 */
function blockSourceQueryOf(query: HoldOffBlockQuery): NormalizedBlockParameter {
  return isAnchoredBlockParameter(query) ? { hash: query.hash } : query;
}

/**
 * Resolves RPC block anchors against the block source, briefly holding a request whose anchor the node is about to
 * see instead of failing it immediately.
 *
 * Behind a load balancer a client can sync to block N+1 through one node and then anchor follow-up queries against
 * another node that is still at block N. Failing those queries aborts a whole client flow over a skew that resolves
 * in under a block time, so a miss on an anchor that plausibly lies just ahead of the tip is retried for a bounded
 * budget. Everything else — a tag, a number far past the tip, a budget of zero, or too many requests already held —
 * resolves exactly as the bare block source would.
 *
 * An {@link AnchoredBlockParameter} names the same block twice, and the two names do different work here. The hash
 * is what the block source is read by, so the fork it pins is honored exactly as a bare hash is. The number only
 * picks how long a miss is waited out, and is checked against whatever the hash resolves to: a hash sitting at
 * another height is a claim this node can disprove, and is refused rather than waited on.
 *
 * Held requests do not poll at a rate of their own choosing: they all sleep on one wake-up that the block source
 * triggers when it reports it moved, so the source is read when there is something new to read and, failing that, at
 * most once per {@link MAX_SLEEP_MS}. A source that reports no updates cannot wake them, so it never holds anything
 * off.
 */
export class UnseenBlockHoldOff {
  private activeHolds = 0;
  private readonly log: Logger;
  /** Shared by every held request; interrupted on a source update. Undefined for a source that reports none. */
  private readonly wakeup: InterruptibleSleep | undefined;

  constructor(
    private readonly blockSource: L2BlockSource | L2BlockSourceEventEmitter,
    private readonly config: UnseenBlockHoldOffConfig,
    log?: Logger,
  ) {
    this.log = log ?? createLogger('node:unseen-block-hold-off');
    const emitter = getBlockSourceEmitter(blockSource);
    if (emitter === undefined) {
      this.log.verbose(`Block source reports no updates, queries for unseen blocks will not be held off`);
    } else {
      const wakeup = new InterruptibleSleep();
      this.wakeup = wakeup;
      emitter.on(L2BlockSourceEvents.L2BlockSourceUpdated, () => wakeup.interrupt());
    }
  }

  /** Number of requests currently held waiting for their anchor block. Exposed for tests and diagnostics. */
  public get holds(): number {
    return this.activeHolds;
  }

  /**
   * Resolves `query` to block metadata, holding off briefly when it references a block the node is about to see.
   * Returns undefined on a miss, so callers keep whatever behavior they had before (throwing or returning
   * undefined) — the hold-off only delays that outcome.
   */
  public getBlockData(query: HoldOffBlockQuery, opts: UnseenBlockHoldOffOptions = {}): Promise<BlockData | undefined> {
    return this.#readWithHoldOff(query, q => this.blockSource.getBlockData(q), opts);
  }

  /** Resolves `query` to a full block with its transactions, holding off as {@link getBlockData} does. */
  public getBlock(query: HoldOffBlockQuery, opts: UnseenBlockHoldOffOptions = {}): Promise<L2Block | undefined> {
    return this.#readWithHoldOff(query, q => this.blockSource.getBlock(q), opts);
  }

  /**
   * Reads `query` through `read`, and on a miss waits for the block it names before reading once more. Subject to the
   * concurrent-hold cap: once it is saturated a miss resolves without waiting, as it would with the hold-off
   * disabled.
   *
   * The second read is the last one: a prune landing between the wait and it leaves the caller with a miss rather
   * than starting a fresh wait, so one request can only ever spend one budget.
   *
   * A query naming a height has its budget decided from a tip read taken after the first read, so the block can have
   * arrived in between. An empty budget leaves no wake-up to notice that, so the read is repeated once before the
   * miss is final.
   */
  async #readWithHoldOff<T extends ReadBlock>(
    query: HoldOffBlockQuery,
    read: (query: NormalizedBlockParameter) => Promise<T | undefined>,
    opts: UnseenBlockHoldOffOptions,
  ): Promise<T | undefined> {
    const lookup = blockSourceQueryOf(query);
    const value = await this.#verifiedRead(query, lookup, read);
    if (value !== undefined || opts.holdOff === false) {
      return value;
    }
    const waitMs = await this.#resolveWaitBudgetMs(query);
    const arrived = await this.#waitForBlock(query, lookup, waitMs);
    const readAgain = arrived || (waitMs === 0 && 'number' in query);
    return readAgain ? await this.#verifiedRead(query, lookup, read) : undefined;
  }

  /** Reads `lookup` through `read` and checks whatever comes back against the anchor `query` names. */
  async #verifiedRead<T extends ReadBlock>(
    query: HoldOffBlockQuery,
    lookup: NormalizedBlockParameter,
    read: (query: NormalizedBlockParameter) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    const value = await read(lookup);
    return value === undefined ? undefined : await this.#verifyAnchor(query, value);
  }

  /**
   * Checks a block read against the anchor it was read for, and returns it only if it is the block the anchor names.
   *
   * A query naming a block one way needs no check: the block source resolved it and there is nothing else to compare
   * it against. An anchor claims two things, and they fail differently. A hash that resolves to a block at another
   * height is a claim the node can disprove, so it is a bad request rather than a miss — waiting cannot make a false
   * claim true. A block that is not the one the hash names is a miss: the block source raced a prune and answered
   * for another fork, which the caller's own wait may still resolve.
   */
  async #verifyAnchor<T extends ReadBlock>(query: HoldOffBlockQuery, value: T): Promise<T | undefined> {
    if (!isAnchoredBlockParameter(query)) {
      return value;
    }
    if (!(await blockHashOf(value)).equals(query.hash)) {
      this.log.verbose(`Block resolved for anchor is on a different fork`, {
        blockParameter: inspectBlockParameter(query),
        resolvedBlockNumber: value.header.getBlockNumber(),
      });
      return undefined;
    }
    const blockNumber = value.header.getBlockNumber();
    if (blockNumber !== query.number) {
      throw new BadRequestError(
        `Anchor block ${query.hash.toString()} is block ${blockNumber}, not the requested block ${query.number}`,
      );
    }
    return value;
  }

  /**
   * Waits for the block `query` names to show up on the block source, for at most `waitMs`, and reports whether it
   * did. Returns false without waiting when the source reports no updates, when the budget is empty, or when the
   * concurrent-hold cap is saturated, so a miss fails as fast as it would with the hold-off disabled.
   *
   * Arrival is checked on block metadata rather than through the caller's read, so a held request costs a metadata
   * read per wake-up whatever it asked for: a held `getBlock` would otherwise reconstruct a whole block with its
   * transactions on every wake-up only to find it is not the one it is waiting for.
   *
   * A budget is approximate: the deadline is only re-checked after a sleep, so the actual wait can exceed it by the
   * read's own latency.
   *
   * The metadata is checked against the anchor `query` names, so a block arriving that is not the one asked for does
   * not end the wait: an anchor names a fork, and a prune that brings that fork back can still land inside the
   * budget already chosen. The deadline is never extended by what arrives in the meantime.
   */
  async #waitForBlock(query: HoldOffBlockQuery, lookup: NormalizedBlockParameter, waitMs: number): Promise<boolean> {
    const wakeup = this.wakeup;
    if (wakeup === undefined || !Number.isFinite(waitMs) || waitMs <= 0) {
      return false;
    }
    const blockParameter = inspectBlockParameter(query);
    if (this.activeHolds >= MAX_CONCURRENT_HOLDS) {
      this.log.verbose(`Not holding off query for unseen block, too many requests already held`, {
        blockParameter,
        holds: this.activeHolds,
      });
      return false;
    }

    this.activeHolds++;
    const timer = new Timer();
    try {
      this.log.verbose(`Holding off query for unseen block`, { blockParameter, waitMs, holds: this.activeHolds });
      while (timer.ms() < waitMs) {
        await wakeup.sleep(Math.min(waitMs - timer.ms(), MAX_SLEEP_MS));
        const read = await this.blockSource.getBlockData(lookup);
        const data = read === undefined ? undefined : await this.#verifyAnchor(query, read);
        if (data !== undefined) {
          this.log.verbose(`Unseen block arrived after ${timer.ms()}ms`, {
            blockParameter,
            blockNumber: data.header.getBlockNumber(),
            elapsedMs: timer.ms(),
          });
          return true;
        }
      }
      this.log.verbose(`Gave up waiting for unseen block after ${timer.ms()}ms`, {
        blockParameter,
        waitMs,
        elapsedMs: timer.ms(),
      });
      return false;
    } finally {
      this.activeHolds--;
    }
  }

  /**
   * Budget for waiting on a missing anchor, decided once on entry rather than per wake-up. A tag always resolves
   * against the current tip, so a tag miss is never a skew. A number is only worth waiting on when it is the very
   * next block: further ahead the client is not merely one block in front, and at or below the tip the block was
   * pruned or reorged away. A hash or archive root carries no height, so "one ahead" and "reorged away" are
   * indistinguishable and both get the shorter hash budget.
   *
   * An anchor carries both, and both readings are worth waiting on, so it never resolves to no budget at all. At one
   * past the tip it is a client a block ahead and gets the longer by-number budget. Anywhere else the hash names a
   * fork this node does not hold, which a prune can still bring back, so it waits on the shorter by-hash budget as a
   * bare hash would.
   *
   * The genesis block hash is the one hash never worth waiting on: a client anchors on it before it has synced any
   * block (as a PXE does for its first tagged-log queries), and the block is synthetic, so a source that does not
   * answer for it now never will.
   */
  async #resolveWaitBudgetMs(query: HoldOffBlockQuery): Promise<number> {
    if ('tag' in query) {
      return 0;
    }
    if (isAnchoredBlockParameter(query)) {
      if (this.#isGenesisBlockHash(query.hash)) {
        return 0;
      }
      const tip = await this.blockSource.getBlockNumber();
      return query.number === tip + 1 ? this.config.byNumberWaitMs : this.config.byHashWaitMs;
    }
    if ('number' in query) {
      const tip = await this.blockSource.getBlockNumber();
      return query.number === tip + 1 ? this.config.byNumberWaitMs : 0;
    }
    if ('hash' in query && this.#isGenesisBlockHash(query.hash)) {
      return 0;
    }
    return this.config.byHashWaitMs;
  }

  /** True when `hash` names the synthetic genesis block, which never arrives and so is never waited for. */
  #isGenesisBlockHash(hash: BlockHash): boolean {
    return hash.equals(this.blockSource.getGenesisBlockHash());
  }
}
