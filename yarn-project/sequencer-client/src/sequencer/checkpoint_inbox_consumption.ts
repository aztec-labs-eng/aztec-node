import { maxBigint, minBigint } from '@aztec-labs/foundation/bigint';
import type { BlockNumber, CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import type { Logger } from '@aztec-labs/foundation/log';
import { type DateProvider, executeTimeout } from '@aztec-labs/foundation/timer';
import type { MerkleTreeReadOperations } from '@aztec-labs/stdlib/interfaces/server';
import { type InboxMessagePosition, InboxMessagePrefixRef, type InboxMessageRange } from '@aztec-labs/stdlib/messaging';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';

import {
  type EndpointResolution,
  type InboxEndpointResolver,
  PROTOCOL_INBOX_CONSUMPTION_CAPS,
  type StreamingMessageSource,
  getEndpointUpperBound,
  mustQueryEndpoint,
  resolveEndpoint,
  selectOrdinaryMessageEnd,
  selectSafeLocalEnd,
} from './inbox_message_selection.js';

/** Cap on the Inbox endpoint read a block makes near the checkpoint cap, well under a sub-slot. */
export const INBOX_ENDPOINT_READ_TIMEOUT_MS = 2_000;

/** What a block's streaming message selection decided. */
export type StreamingBundleSelection =
  | {
      /** Build the block over this range; the block signs `range.end` as its prefix reference. */
      kind: 'consume';
      range: InboxMessageRange;
    }
  | {
      /** No checkpoint ending this way can be published; give up the slot without signing anything more. */
      kind: 'abort';
      reason: string;
      context?: Record<string, unknown>;
    };

/** What the forced tail block, built after the sub-slot schedule ran out, has to do to end on a live bucket end. */
export type ForcedEndpointDecision =
  | {
      /** Build one message-only block over this range, ending on the endpoint, before `deadline`. */
      kind: 'consume';
      range: InboxMessageRange;
      deadline: Date;
    }
  | {
      /** The cursor already sits on a live bucket end; the checkpoint publishes as it stands. */
      kind: 'already-at-endpoint';
    }
  | {
      /** No live bucket end is reachable; the checkpoint has to be abandoned. */
      kind: 'abort';
      reason: string;
      context: Record<string, unknown>;
    };

/** Collaborators of {@link CheckpointInboxConsumption}. */
export type CheckpointInboxConsumptionDeps = {
  messageSource: StreamingMessageSource;
  inbox: InboxEndpointResolver;
  dateProvider: DateProvider;
  log: Logger;
  /** Fields prepended to every log line the consumption emits. */
  logContext: { slot: SlotNumber; checkpointNumber: CheckpointNumber };
};

/** The inputs one selection attempt decides from, read once at its start. */
type SelectionSnapshot = {
  cursor: InboxMessagePosition;
  cursorCount: bigint;
  localSyncedCount: bigint;
  checkpointStartCount: bigint;
  caps: typeof PROTOCOL_INBOX_CONSUMPTION_CAPS;
};

/**
 * Streaming Inbox consumption of one checkpoint: the cursor and every range decision made from it. Consumption starts
 * from the parent checkpoint's consumed message prefix and advances one block at a time, greedily on the local log
 * while the step stays clear of the checkpoint cap and against a live L1 bucket end once it does not.
 *
 * Invariants:
 * - Nothing is cached across attempts: every selection re-derives from the current cursor and the current local view,
 *   so a block that fails to build and is retried is offered the same messages again.
 * - Each selection reads the cursor and the local synced position once, at its start, and decides only from those.
 * - Selections never modify the cursor. Only {@link commit} does, after a block built over the selected range, and it
 *   replaces the cursor rather than modifying the position in place. An endpoint lookup that lost its timeout race
 *   and keeps running therefore only ever reads a position that stays valid.
 */
export class CheckpointInboxConsumption {
  private constructor(
    /** Cumulative Inbox message count consumed as of the parent checkpoint; the per-checkpoint cap origin. */
    readonly checkpointStartTotalMsgCount: bigint,
    /** The message prefix consumed so far (the parent checkpoint's until a block of this checkpoint builds). */
    private cursor: InboxMessagePosition,
    private readonly deps: CheckpointInboxConsumptionDeps,
  ) {}

  /**
   * Starts consumption at the parent checkpoint's consumed message prefix. The parent's cumulative consumed total is
   * the L1-to-L2 message tree leaf count of the fork this checkpoint builds on (compact indexing makes leaf count equal
   * cumulative message count), and the local message log serves the prefix hash at that count. Genesis is the
   * `total = 0` case with a zero hash.
   */
  static async start(
    fork: Pick<MerkleTreeReadOperations, 'getTreeInfo'>,
    deps: CheckpointInboxConsumptionDeps,
  ): Promise<CheckpointInboxConsumption> {
    const checkpointStartTotalMsgCount = (await fork.getTreeInfo(MerkleTreeId.L1_TO_L2_MESSAGE_TREE)).size;
    const cursor = await deps.messageSource.getMessagePosition(checkpointStartTotalMsgCount);
    if (cursor === undefined) {
      throw new Error(
        `Streaming inbox: cannot resolve the Inbox message prefix at cumulative total ${checkpointStartTotalMsgCount} ` +
          `(checkpoint ${deps.logContext.checkpointNumber}); local Inbox view has not synced it`,
      );
    }
    return new CheckpointInboxConsumption(checkpointStartTotalMsgCount, cursor, deps);
  }

  /** Cumulative chain total consumed through the cursor (not this checkpoint's delta). */
  get consumedTotalMsgCount(): bigint {
    return this.cursor.totalMessageCount;
  }

  /** Whether any block of this checkpoint has advanced the cursor past the checkpoint start. */
  get hasConsumedInThisCheckpoint(): boolean {
    return this.cursor.totalMessageCount > this.checkpointStartTotalMsgCount;
  }

  /**
   * Selects the message range the next block consumes. Does not advance the cursor; the caller commits the range
   * only after the block builds successfully.
   *
   * Selection is greedy on the local log: every message the archiver has observed, up to the per-block and
   * checkpoint caps. A block consults L1 only when it is the checkpoint's final block, whose position must be a live
   * L1 bucket end, or when its prospective end would pass the threshold one bucket below the cap and could leave the
   * last legal endpoint behind. The lookup is bounded by the checkpoint cap on a non-final block, so a mandatory
   * bucket beyond this block's own reach is not stranded by a nearer endpoint, and additionally by one block's
   * capacity on the final block. A non-final block then ends at the further of what the lookup allows and the safe
   * local step, so consulting L1 never consumes less than staying below the threshold would have, and it may
   * legitimately end inside a bucket. The final block instead ends exactly on the resolved boundary, so whenever the
   * last live boundary within reach sits behind the safe local step it consumes fewer messages than the local log
   * alone would allow. Nothing is retained: the next attempt decides again.
   *
   * An endpoint that cannot be resolved on a non-final block (local lag, no live endpoint yet) leaves the block with
   * that safe local step and is retried on the next block; on the final block it abandons the checkpoint. A local
   * prefix that no longer matches the cursor means the blocks already signed were built on messages the local log
   * has since replaced, which also abandons the checkpoint.
   */
  async selectRange(opts: { isFinalBlock: boolean; buildDeadline: number }): Promise<StreamingBundleSelection> {
    const snapshot = await this.takeSnapshot();
    const { cursor, cursorCount, localSyncedCount, checkpointStartCount, caps } = snapshot;
    const greedyEnd = selectOrdinaryMessageEnd(snapshot);

    if (
      !mustQueryEndpoint({ prospectiveEnd: greedyEnd, checkpointStartCount, isFinalBlock: opts.isFinalBlock, caps })
    ) {
      return this.readRange(cursor, greedyEnd);
    }

    const upperBound = getEndpointUpperBound({ ...snapshot, isFinalBlock: opts.isFinalBlock });
    const resolved = await this.resolveEndpointWithinDeadline(cursor, upperBound, opts.buildDeadline);
    const safeLocalEnd = selectSafeLocalEnd(snapshot);
    if (!resolved.ok) {
      if (resolved.reason === 'local_prefix_changed') {
        return { kind: 'abort', reason: 'inbox_prefix_reorged', context: { upperBound } };
      }
      if (opts.isFinalBlock) {
        return {
          kind: 'abort',
          reason: 'inbox_completion_unresolved',
          context: { cause: resolved.reason, upperBound, endpointTotal: resolved.endpointTotal, localSyncedCount },
        };
      }
      this.deps.log.warn(`Streaming Inbox endpoint not resolvable yet, taking the safe local step`, {
        ...this.deps.logContext,
        cause: resolved.reason,
        cursorTotalMsgCount: cursorCount,
        localSyncedCount,
        upperBound,
        endpointTotal: resolved.endpointTotal,
        safeLocalEnd,
      });
      return this.readRange(cursor, safeLocalEnd);
    }

    const endpointTotal = resolved.endpoint.totalMessageCount;
    const endpointEnd = minBigint(cursorCount + BigInt(caps.perBlockCap), endpointTotal);
    // The final block has to land on the endpoint, so it takes it even when the safe local step reaches further; any
    // other block takes the further of the two, so consulting L1 never consumes less than staying below the
    // threshold would have.
    const end = opts.isFinalBlock ? endpointEnd : maxBigint(safeLocalEnd, endpointEnd);
    this.deps.log.verbose(`Streaming Inbox resolved endpoint ${endpointTotal}, consuming through ${end}`, {
      ...this.deps.logContext,
      cursorTotalMsgCount: cursorCount,
      localSyncedCount,
      upperBound,
      endpointTotalMsgCount: endpointTotal,
      bucketSeq: resolved.bucketSeq,
      end,
    });
    // An end short of or past the endpoint needs its own read, so the signed hash is the one at `end` and never the
    // endpoint's; landing exactly on the endpoint reuses the snapshot the resolver already read and checked against
    // the cursor's hash.
    return end === endpointTotal ? { kind: 'consume', range: resolved.range } : this.readRange(cursor, end);
  }

  /**
   * Decides the forced tail block that ends the checkpoint at a live L1 bucket end after the sub-slot schedule ran out
   * mid-checkpoint, resolving the endpoint the way the checkpoint's final block would. Does not advance the cursor.
   * The deadline is taken from `getDeadline` only once the local view has been read, so it reflects the time the
   * lookup actually starts at.
   */
  async resolveForcedEndpoint(opts: {
    blockNumber: BlockNumber;
    getDeadline: () => { deadline: Date; pastLastBlockBuildTime: boolean };
  }): Promise<ForcedEndpointDecision> {
    const snapshot = await this.takeSnapshot();
    const { cursor, cursorCount, localSyncedCount } = snapshot;
    const upperBound = getEndpointUpperBound({ ...snapshot, isFinalBlock: true });
    const { deadline, pastLastBlockBuildTime } = opts.getDeadline();
    this.deps.log.warn(
      `Ending checkpoint ${this.deps.logContext.checkpointNumber} with a forced Inbox endpoint block`,
      {
        ...this.deps.logContext,
        blockNumber: opts.blockNumber,
        cursorTotalMsgCount: cursorCount,
        upperBound,
        deadline: deadline.toISOString(),
        pastLastBlockBuildTime,
      },
    );

    const resolved = await this.resolveEndpointWithinDeadline(cursor, upperBound, deadline.getTime() / 1000);
    if (!resolved.ok) {
      return {
        kind: 'abort',
        reason: resolved.reason === 'local_prefix_changed' ? 'inbox_prefix_reorged' : 'inbox_completion_unresolved',
        context: { cause: resolved.reason, upperBound, endpointTotal: resolved.endpointTotal, localSyncedCount },
      };
    }
    if (resolved.endpoint.totalMessageCount === cursorCount) {
      this.deps.log.verbose(
        `Checkpoint ${this.deps.logContext.checkpointNumber} already ends at a live Inbox bucket end`,
        { ...this.deps.logContext, cursorTotalMsgCount: cursorCount },
      );
      return { kind: 'already-at-endpoint' };
    }
    return { kind: 'consume', range: resolved.range, deadline };
  }

  /**
   * Advances the cursor to `range.end` after a block built over `range`, and returns the prefix reference that block
   * signs. A block that consumed nothing re-signs the cursor's prefix. Throws if the range does not start at the
   * cursor, which would mean it was not selected from the current cursor.
   */
  commit(range: InboxMessageRange): InboxMessagePrefixRef {
    if (
      range.start.totalMessageCount !== this.cursor.totalMessageCount ||
      !range.start.rollingHash.equals(this.cursor.rollingHash)
    ) {
      throw new Error(
        `Streaming inbox: cannot commit a range starting at message total ${range.start.totalMessageCount} ` +
          `with the cursor at ${this.cursor.totalMessageCount} (checkpoint ${this.deps.logContext.checkpointNumber})`,
      );
    }
    this.cursor = range.end;
    return InboxMessagePrefixRef.fromPosition(this.cursor);
  }

  /** The consumption fields reported when a checkpoint is abandoned. */
  toLogContext(): { checkpointStartTotalMsgCount: bigint; consumedTotalMsgCount: bigint; inboxRollingHash: string } {
    return {
      checkpointStartTotalMsgCount: this.checkpointStartTotalMsgCount,
      consumedTotalMsgCount: this.cursor.totalMessageCount,
      inboxRollingHash: this.cursor.rollingHash.toString(),
    };
  }

  private async takeSnapshot(): Promise<SelectionSnapshot> {
    const cursor = this.cursor;
    const localSyncedCount = (await this.deps.messageSource.getSyncedMessagePosition()).totalMessageCount;
    return {
      cursor,
      cursorCount: cursor.totalMessageCount,
      localSyncedCount,
      checkpointStartCount: this.checkpointStartTotalMsgCount,
      caps: PROTOCOL_INBOX_CONSUMPTION_CAPS,
    };
  }

  /**
   * Reads the messages from the cursor to `end` together with the positions at both ends from one snapshot of the
   * local log, and checks that the log still starts where the cursor says: the blocks signed so far were built on
   * that prefix, so a changed prefix (a content-changing L1 reorg) means the checkpoint cannot continue. A range the
   * log can no longer serve whole is the same condition.
   */
  private async readRange(cursor: InboxMessagePosition, end: bigint): Promise<StreamingBundleSelection> {
    let range: InboxMessageRange;
    try {
      range = await this.deps.messageSource.getL1ToL2MessageRange(cursor.totalMessageCount, end);
    } catch (err) {
      return {
        kind: 'abort',
        reason: 'inbox_range_unavailable',
        context: { end, error: err instanceof Error ? err.message : String(err) },
      };
    }
    if (!range.start.rollingHash.equals(cursor.rollingHash)) {
      return {
        kind: 'abort',
        reason: 'inbox_prefix_reorged',
        context: { end, localPrefixHash: range.start.rollingHash.toString() },
      };
    }
    return { kind: 'consume', range };
  }

  /**
   * Runs the single Inbox endpoint query of an endpoint block within the block's build deadline. The lookup gets at
   * least a millisecond even past the deadline, and any failure, a timeout included, reads as no live endpoint.
   */
  private resolveEndpointWithinDeadline(
    cursor: InboxMessagePosition,
    upperBound: bigint,
    buildDeadline: number,
  ): Promise<EndpointResolution> {
    const remainingMs = buildDeadline * 1000 - this.deps.dateProvider.now();
    const timeoutMs = Math.max(1, Math.min(INBOX_ENDPOINT_READ_TIMEOUT_MS, remainingMs));
    return executeTimeout(
      () => resolveEndpoint({ inbox: this.deps.inbox, messageSource: this.deps.messageSource, cursor, upperBound }),
      timeoutMs,
      `Inbox endpoint lookup at or before message total ${upperBound}`,
    ).catch((err): EndpointResolution => {
      this.deps.log.warn(`Inbox endpoint lookup failed, treating the endpoint as unresolved: ${err}`, {
        ...this.deps.logContext,
        upperBound,
      });
      return { ok: false, reason: 'no_live_endpoint', upperBound };
    });
  }
}
