import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { z } from 'zod';

/**
 * Index of a leaf within a merkle tree.
 *
 * The tallest configured trees are 42 levels deep, so a full-tree "next available" position needs 43 bits and does
 * not fit in a uint32. Indices are kept as JavaScript numbers, which are exact through 53 bits, and are constrained
 * to the non-negative safe-integer range so that a value that cannot be represented exactly fails loudly instead of
 * silently losing precision. The binary encoding of a leaf index is a uint64.
 */
export type TreeLeafIndex = number;

/**
 * Checks that a number is a usable tree leaf index.
 * @param value - The candidate index.
 * @returns The same value.
 * @throws If the value is negative, fractional, or outside the safe integer range.
 */
export function TreeLeafIndex(value: number): TreeLeafIndex {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid tree leaf index ${value}: must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Converts a bigint to a tree leaf index.
 * @param value - The candidate index.
 * @returns The index as a number.
 * @throws If the value is negative or exceeds `Number.MAX_SAFE_INTEGER`.
 */
TreeLeafIndex.fromBigInt = function (value: bigint): TreeLeafIndex {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Invalid tree leaf index ${value}: must be a non-negative safe integer`);
  }
  return Number(value);
};

/**
 * Converts a field to a tree leaf index.
 * @param value - The candidate index.
 * @returns The index as a number.
 * @throws If the field does not hold a non-negative safe integer.
 */
TreeLeafIndex.fromField = function (value: Fr): TreeLeafIndex {
  return TreeLeafIndex(value.toNumber());
};

/**
 * Zod schema for a tree leaf index. Strings and bigints are parsed through an exact integer representation, so an
 * out-of-range value is rejected rather than rounded on its way to a number.
 */
export const TreeLeafIndexSchema = z
  .union([
    z.number(),
    z.bigint(),
    z
      .string()
      .regex(/^\d+$/, 'Tree leaf index string must be a non-negative decimal integer')
      .transform(value => BigInt(value)),
  ])
  .transform((value, ctx) => {
    try {
      return typeof value === 'bigint' ? TreeLeafIndex.fromBigInt(value) : TreeLeafIndex(value);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (err as Error).message });
      return z.NEVER;
    }
  });
