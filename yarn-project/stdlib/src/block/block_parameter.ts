import { type BlockNumber, BlockNumberSchema } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { schemas, selectorSchema } from '@aztec-labs/foundation/schemas';
import { z } from 'zod';

import { BlockHash } from './block_hash.js';

export const BlockTag = ['latest', 'proposed', 'checkpointed', 'proven', 'finalized'] as const;

/**
 * Tag identifying a block by its position in the chain rather than by an absolute identifier.
 * - `latest` / `proposed`: Latest L2 block proposed (not necessarily checkpointed/proven yet).
 * - `checkpointed`: Latest L2 block whose enclosing checkpoint has been published on L1.
 * - `proven`: Latest L2 block whose enclosing checkpoint has been proven on L1.
 * - `finalized`: Latest L2 block whose proving L1 transaction has reached L1 finality.
 */
export type BlockTag = (typeof BlockTag)[number];

export const BlockTagWithoutLatestSchema = z.union([
  z.literal('proposed'),
  z.literal('checkpointed'),
  z.literal('proven'),
  z.literal('finalized'),
]);

export const BlockTagSchema: z.ZodType<BlockTag> = z.union([z.literal('latest'), BlockTagWithoutLatestSchema]);

/**
 * Object-only form of {@link BlockParameter}. Used as the building block for {@link BlockQuery}.
 */
export type NormalizedBlockParameter =
  | { number: BlockNumber }
  | { hash: BlockHash }
  | { archive: Fr }
  | { tag: Exclude<BlockTag, 'latest'> };

/**
 * Every key the block-selecting APIs know, across all of them: the ways of naming one block and the ways of naming a
 * range of them. A selector is parsed leniently about keys outside this list and strictly about the ones in it, so
 * asking for one block with a key that means something to a range query is refused rather than quietly dropped.
 */
export const BLOCK_QUERY_KEYS = [
  'number',
  'hash',
  'archive',
  'tag',
  'from',
  'limit',
  'epoch',
  'onlyCheckpointed',
] as const;

/** The object shapes naming a block one way, shared by every block selector below. */
const singleBlockSelectors = [
  z.object({ number: BlockNumberSchema }),
  z.object({ hash: BlockHash.schema }),
  z.object({ archive: schemas.Fr }),
  z.object({ tag: BlockTagWithoutLatestSchema }),
] as const;

export const NormalizedBlockParameterSchema: z.ZodType<NormalizedBlockParameter, unknown> = selectorSchema(
  singleBlockSelectors,
  BLOCK_QUERY_KEYS,
);

/**
 * Anchor naming a block by both its height and its hash.
 *
 * The hash pins the fork, exactly as a bare `{ hash }` does, and is what every lookup past the RPC boundary goes by.
 * The number only tells a server that has not seen the block whether the anchor is the block right after its tip — a
 * client that raced ahead by one — or a block it should already hold, which means the anchor was reorged away and a
 * prune may yet bring it back. Both readings are worth waiting out, for different budgets.
 */
export type AnchoredBlockParameter = { number: BlockNumber; hash: BlockHash };

/** The object shape of an {@link AnchoredBlockParameter}, for selectors that accept one. */
export const anchoredBlockSelector = z.object({ number: BlockNumberSchema, hash: BlockHash.schema });

export const AnchoredBlockParameterSchema: z.ZodType<AnchoredBlockParameter, unknown> = selectorSchema(
  [anchoredBlockSelector],
  BLOCK_QUERY_KEYS,
);

/**
 * Selector for a block in RPC calls.
 *
 * Accepts a block number, a {@link BlockHash}, a chain-tip name (e.g. `'proven'`, `'checkpointed'`),
 * `'latest'` (alias for `'proposed'`), any of the {@link NormalizedBlockParameter} object variants
 * (`{ number }`, `{ hash }`, `{ archive }`, `{ tag }`), or the {@link AnchoredBlockParameter} form
 * (`{ number, hash }`).
 */
export type BlockParameter = NormalizedBlockParameter | AnchoredBlockParameter | BlockNumber | BlockHash | BlockTag;

export const BlockParameterSchema: z.ZodType<BlockParameter, unknown> = z.union([
  selectorSchema<AnchoredBlockParameter | NormalizedBlockParameter>(
    [anchoredBlockSelector, ...singleBlockSelectors],
    BLOCK_QUERY_KEYS,
  ),
  BlockHash.schema,
  BlockTagSchema,
  BlockNumberSchema,
]);

/** True when `param` is an {@link AnchoredBlockParameter}, naming a block by both its number and its hash. */
export function isAnchoredBlockParameter(param: BlockParameter): param is AnchoredBlockParameter {
  return (
    typeof param === 'object' &&
    param !== null &&
    'number' in param &&
    param.number !== undefined &&
    'hash' in param &&
    param.hash !== undefined
  );
}

/**
 * The block hash `param` pins, or `undefined` when it names a block in a way a reorg can move (a number or a tag) or
 * by an archive root. Every hash-bearing form — a bare {@link BlockHash}, `{ hash }`, and the anchored
 * `{ number, hash }` — pins the same block, so callers that only care which fork the answer belongs to treat them
 * alike.
 */
export function blockParameterHash(param: BlockParameter): BlockHash | undefined {
  if (BlockHash.isBlockHash(param)) {
    return param;
  }
  if (typeof param === 'object' && param !== null && 'hash' in param) {
    return param.hash;
  }
  return undefined;
}

export function inspectBlockParameter(param: BlockParameter) {
  if (typeof param === 'number') {
    return param.toString();
  } else if (typeof param === 'string') {
    return param;
  } else if ('number' in param && 'hash' in param) {
    return `number=${param.number.toString()},hash=${param.hash.toString()}`;
  } else if ('number' in param) {
    return `number=${param.number.toString()}`;
  } else if ('hash' in param) {
    return `hash=${param.hash.toString()}`;
  } else if ('archive' in param) {
    return `archive=${param.archive.toString()}`;
  } else if ('tag' in param) {
    return `tag=${param.tag}`;
  } else {
    return jsonStringify(param);
  }
}
