import { BlockNumberSchema } from '@aztec-labs/foundation/branded-types';
import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { z } from 'zod';

import type { AztecAddress } from '../aztec-address/index.js';
import { BlockHash } from '../block/block_hash.js';
import { type AnchoredBlockParameter, AnchoredBlockParameterSchema } from '../block/block_parameter.js';
import { MAX_LOGS_PER_TAG, MAX_RPC_LEN } from '../interfaces/api_limit.js';
import { type ZodFor, schemas, zodFor } from '../schemas/index.js';
import { TxHash } from '../tx/tx_hash.js';
import { LogCursor } from './log_cursor.js';
import { SiloedTag } from './siloed_tag.js';
import { Tag } from './tag.js';

/**
 * A tag to query in {@link PrivateLogsQuery} / {@link PublicLogsQuery}, optionally resuming strictly
 * after a previously-seen log via `afterLog`. The bare `T` form means "from the beginning".
 */
export type TagQuery<T extends Tag | SiloedTag> = T | { tag: T; afterLog?: LogCursor };

/**
 * Reorg-safety anchor of a logs query: a bare {@link BlockHash}, or the {@link AnchoredBlockParameter} form that
 * carries the anchor's height alongside its hash.
 *
 * Both forms pin a fork, which is what an anchor is for. Only the height differs, and a node that has not seen the
 * anchor block uses it to pick how long to wait for it. Forms that do not pin a fork — a number, a tag, an archive
 * root — are deliberately not accepted: a reorg moves what sits at such a position, so they would silently weaken
 * the guarantee the anchor exists to give.
 */
export type LogsQueryAnchor = BlockHash | AnchoredBlockParameter;

export const LogsQueryAnchorSchema: ZodFor<LogsQueryAnchor> = z.union([
  BlockHash.schema,
  AnchoredBlockParameterSchema,
]) as ZodFor<LogsQueryAnchor>;

/**
 * Shared fields for {@link PrivateLogsQuery} and {@link PublicLogsQuery}.
 */
export type LogsQueryBase = {
  /** Lower block bound, inclusive. */
  fromBlock?: BlockNumber;
  /** Upper block bound, exclusive. */
  toBlock?: BlockNumber;
  /**
   * Restrict results to logs emitted in this transaction. Mutually exclusive with `fromBlock`/`toBlock`
   * (a txHash already pins a block). `txHash` + `afterLog` is allowed and paginates within the tx's logs
   * for that tag.
   */
  txHash?: TxHash;
  /**
   * Reorg-safety anchor: the latest block the caller has synced to. The call throws if that block is no longer
   * present. Results are capped at that block, and `toBlock` can only narrow the range further, never past it.
   */
  referenceBlock?: LogsQueryAnchor;
  /** When set, each log also carries `noteHashes` and all `nullifiers` for note-nonce discovery. */
  includeEffects?: boolean;
  /**
   * Maximum number of logs returned per tag. Capped at {@link MAX_LOGS_PER_TAG} (rejected if higher).
   * Defaults to {@link MAX_LOGS_PER_TAG} when unset. Mainly useful for tests that need to force
   * pagination at a small page size.
   */
  limitPerTag?: number;
};

/**
 * Query for {@link L2LogsSource.getPrivateLogsByTags}. Returns one inner array per element of `tags`,
 * in input order.
 */
export type PrivateLogsQuery = LogsQueryBase & {
  /** Tags to query. Between 1 and {@link MAX_RPC_LEN} entries (inclusive). */
  tags: TagQuery<SiloedTag>[];
};

/**
 * Query for {@link L2LogsSource.getPublicLogsByTags}. Returns one inner array per element of `tags`,
 * in input order.
 */
export type PublicLogsQuery = LogsQueryBase & {
  /** Contract address that emitted the logs. Required for public queries. */
  contractAddress: AztecAddress;
  /** Tags to query. Between 1 and {@link MAX_RPC_LEN} entries (inclusive). */
  tags: TagQuery<Tag>[];
};

function tagQuerySchema<T extends Tag | SiloedTag>(tagSchema: ZodFor<T>) {
  return z.union([
    tagSchema,
    z.object({
      tag: tagSchema,
      afterLog: LogCursor.schema.optional(),
    }),
  ]) as ZodFor<TagQuery<T>>;
}

const logsQueryBaseShape = {
  fromBlock: BlockNumberSchema.optional(),
  toBlock: BlockNumberSchema.optional(),
  txHash: TxHash.schema.optional(),
  referenceBlock: LogsQueryAnchorSchema.optional(),
  includeEffects: z.boolean().optional(),
  limitPerTag: z
    .number()
    .int()
    .positive()
    .max(MAX_LOGS_PER_TAG, { message: `limitPerTag must be <= ${MAX_LOGS_PER_TAG}` })
    .optional(),
};

/** Minimal shape required by {@link refineTxHashAndRange}. */
type TxHashAndRangeFields = {
  /** Tx hash filter. */
  txHash?: TxHash;
  /** Lower block bound. */
  fromBlock?: BlockNumber;
  /** Upper block bound (exclusive). */
  toBlock?: BlockNumber;
};

/**
 * Refinement: a `txHash` already pins a block, so combining it with a block range is contradictory.
 * (`txHash` + `afterLog` is still allowed and is enforced per-tag inside `TagQuery`.) Exported so
 * `aztec.js`'s wallet event-filter schemas can reuse the same rule.
 */
export function refineTxHashAndRange<T extends TxHashAndRangeFields>(schema: z.ZodType<T>) {
  return schema.refine(q => !(q.txHash !== undefined && (q.fromBlock !== undefined || q.toBlock !== undefined)), {
    message: '`txHash` is mutually exclusive with `fromBlock`/`toBlock`',
  });
}

const privateTagsSchema = z
  .array(tagQuerySchema(SiloedTag.schema))
  .min(1)
  .max(MAX_RPC_LEN, { message: `tags must have at most ${MAX_RPC_LEN} entries` });

const publicTagsSchema = z
  .array(tagQuerySchema(Tag.schema))
  .min(1)
  .max(MAX_RPC_LEN, { message: `tags must have at most ${MAX_RPC_LEN} entries` });

export const PrivateLogsQuerySchema: ZodFor<PrivateLogsQuery> = refineTxHashAndRange(
  zodFor<PrivateLogsQuery>()(z.object({ ...logsQueryBaseShape, tags: privateTagsSchema })),
);

export const PublicLogsQuerySchema: ZodFor<PublicLogsQuery> = refineTxHashAndRange(
  zodFor<PublicLogsQuery>()(
    z.object({ ...logsQueryBaseShape, contractAddress: schemas.AztecAddress, tags: publicTagsSchema }),
  ),
);

/**
 * A logs query whose anchor the node has already resolved to the concrete block hash a logs source checks against.
 *
 * The wire form accepts either anchor form, and the node RPC layer reduces the anchored one to its hash — validating
 * the height it claims on the way — before the query reaches a logs source. Everything below that boundary works in
 * hashes alone.
 */
export type ResolvedLogsQuery<T extends LogsQueryBase> = Omit<T, 'referenceBlock'> & { referenceBlock?: BlockHash };

const resolvedLogsQueryBaseShape = { ...logsQueryBaseShape, referenceBlock: BlockHash.schema.optional() };

export const ResolvedPrivateLogsQuerySchema: ZodFor<ResolvedLogsQuery<PrivateLogsQuery>> = refineTxHashAndRange(
  zodFor<ResolvedLogsQuery<PrivateLogsQuery>>()(z.object({ ...resolvedLogsQueryBaseShape, tags: privateTagsSchema })),
);

export const ResolvedPublicLogsQuerySchema: ZodFor<ResolvedLogsQuery<PublicLogsQuery>> = refineTxHashAndRange(
  zodFor<ResolvedLogsQuery<PublicLogsQuery>>()(
    z.object({ ...resolvedLogsQueryBaseShape, contractAddress: schemas.AztecAddress, tags: publicTagsSchema }),
  ),
);
