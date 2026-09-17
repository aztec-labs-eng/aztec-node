import { type BlockNumber, BlockNumberSchema } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { schemas } from '@aztec-labs/foundation/schemas';
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

const normalizedBlockParameterObjectSchema = z.object({
  number: z.unknown().optional(),
  hash: z.unknown().optional(),
  archive: z.unknown().optional(),
  tag: z.unknown().optional(),
});

const normalizedBlockParameterVariants = z.union([
  z.object({ number: BlockNumberSchema }).strict(),
  z.object({ hash: BlockHash.schema }).strict(),
  z.object({ archive: schemas.Fr }).strict(),
  z.object({ tag: BlockTagWithoutLatestSchema }).strict(),
]);

export const NormalizedBlockParameterSchema: z.ZodType<NormalizedBlockParameter, unknown> =
  normalizedBlockParameterObjectSchema.pipe(normalizedBlockParameterVariants);

/**
 * Anchor naming a block by both its height and its hash.
 *
 * The hash pins the fork, exactly as a bare `{ hash }` does, and is what every lookup past the RPC boundary goes by.
 * The number only tells a server that has not seen the block whether the anchor is the block right after its tip — a
 * client that raced ahead by one — or a block it should already hold, which means the anchor was reorged away and a
 * prune may yet bring it back. Both readings are worth waiting out, for different budgets.
 */
export type AnchoredBlockParameter = { number: BlockNumber; hash: BlockHash };

export const AnchoredBlockParameterSchema: z.ZodType<AnchoredBlockParameter, unknown> = z.object({
  number: BlockNumberSchema,
  hash: BlockHash.schema,
});

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
  normalizedBlockParameterObjectSchema.pipe(
    z.union([
      z.object({ number: BlockNumberSchema, hash: BlockHash.schema }).strict(),
      normalizedBlockParameterVariants,
    ]),
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
