import { DomainSeparator } from '@aztec-labs/constants';
import { type BlockNumber, BlockNumberSchema } from '@aztec-labs/foundation/branded-types';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import {
  SiblingPath,
  UnbalancedMerkleTreeCalculator,
  computeRootFromSiblingPath,
  makePoseidonMerkleHash,
} from '@aztec-labs/foundation/trees';
import { z } from 'zod';

import { schemas } from '../schemas/schemas.js';
import type { TxEffect } from './tx_effect.js';
import type { TxHash } from './tx_hash.js';

/**
 * Hasher for the internal nodes of a block's tx effects tree. Must match the accumulation the rollup circuits perform
 * up the tx rollup tree.
 */
export const txEffectsTreeNodeHash = makePoseidonMerkleHash(DomainSeparator.TX_EFFECTS_TREE);

/**
 * Proof that a tx was included in a block and produced exactly the effects the block reports for it.
 *
 * The witness is verified against `BlockHeader.txEffectsTreeRoot` of block {@link blockNumber} by hashing the tx's leaf
 * (`computeTxEffectsTreeLeaf(txHash, categoriesHash)`) up the sibling path. This proves transaction inclusion without
 * fetching the full effects. To also verify specific effects, recompute their categories hash and compare it with
 * the witness.
 */
export type TxEffectMembershipWitness = {
  /** Block the tx was included in, whose header carries the root this witness is built against. */
  blockNumber: BlockNumber;
  /** Root of the block's tx effects tree, equal to `BlockHeader.txEffectsTreeRoot`. */
  root: Fr;
  /** Hash of the tx effect categories, used with the tx hash to reconstruct the leaf. */
  categoriesHash: Fr;
  /**
   * Index of the tx's leaf at its own depth in the tree, least significant bit first. The tree is unbalanced (greedily
   * filled), so leaves sit at different depths and this is not the tx's index within the block.
   */
  leafIndex: bigint;
  /** Sibling path from the tx's leaf up to the root, lowest level first. */
  siblingPath: SiblingPath<number>;
};

/**
 * Zod schema for {@link TxEffectMembershipWitness}. The sibling-path length varies per leaf because the tree is
 * unbalanced, so we use the unsized `SiblingPath.schema` here rather than a fixed-height `schemaFor`.
 */
export const TxEffectMembershipWitnessSchema = z.object({
  blockNumber: BlockNumberSchema,
  root: schemas.Fr,
  categoriesHash: schemas.Fr,
  leafIndex: schemas.BigInt,
  siblingPath: SiblingPath.schema,
}) as unknown as z.ZodType<TxEffectMembershipWitness>;

/** Precomputed tx effects tree leaves and their categories hashes, both in block order. */
export type TxEffectsTreeData = { leaves: readonly Fr[]; categoriesHashes: readonly Fr[] };

/** Computes a domain-separated leaf binding a transaction hash to its effects categories hash. */
export function computeTxEffectsTreeLeaf(txHash: TxHash, categoriesHash: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([txHash.hash, categoriesHash], DomainSeparator.TX_EFFECTS_TREE_LEAF);
}

/** Computes each categories hash once and retains it alongside the corresponding leaf. */
export async function computeTxEffectsTreeData(txEffects: TxEffect[]): Promise<TxEffectsTreeData> {
  const entries = await Promise.all(
    txEffects.map(async txEffect => {
      const categoriesHash = await txEffect.computeTxEffectCategoriesHash();
      const leaf = await txEffect.computeTxEffectsTreeLeaf(categoriesHash);
      return { leaf, categoriesHash };
    }),
  );
  return { leaves: entries.map(entry => entry.leaf), categoriesHashes: entries.map(entry => entry.categoriesHash) };
}

/**
 * Computes the leaves of a block's tx effects tree, in block order. Each leaf is an expensive structured hash over the
 * tx's full effect data, so callers that need the leaves more than once should keep them around.
 *
 * @param txEffects - All tx effects of the block, in block order.
 */
export function computeTxEffectLeaves(txEffects: TxEffect[]): Promise<Fr[]> {
  return Promise.all(txEffects.map(txEffect => txEffect.computeTxEffectsTreeLeaf()));
}

/**
 * Rebuilds a block's tx effects tree from all its tx effects and returns the membership witness for the tx at
 * `txIndexInBlock`. The returned root must be checked against the block header's `txEffectsTreeRoot` by the caller.
 *
 * @param txEffects - All tx effects of the block, in block order.
 * @param txIndexInBlock - Index within the block of the tx to prove.
 */
export async function computeTxEffectMembershipWitness(
  txEffects: TxEffect[],
  txIndexInBlock: number,
): Promise<Omit<TxEffectMembershipWitness, 'blockNumber'>> {
  const { leaves, categoriesHashes } = await computeTxEffectsTreeData(txEffects);
  const witness = await computeTxEffectMembershipWitnessFromLeaves(leaves, txIndexInBlock);
  return { ...witness, categoriesHash: categoriesHashes[txIndexInBlock] };
}

/**
 * Rebuilds a block's tx effects tree from its precomputed leaves and returns the root and membership path for the tx at
 * `txIndexInBlock`. The returned root must be checked against the block header's `txEffectsTreeRoot` by the caller.
 *
 * Only the internal nodes are hashed here (one cheap two-field hash per tx), so this is the cheap path for callers
 * that already hold the leaves.
 *
 * @param leaves - Leaves of the block's tx effects tree, in block order.
 * @param txIndexInBlock - Index within the block of the tx to prove.
 */
export async function computeTxEffectMembershipWitnessFromLeaves(
  leaves: readonly Fr[],
  txIndexInBlock: number,
): Promise<Omit<TxEffectMembershipWitness, 'blockNumber' | 'categoriesHash'>> {
  if (txIndexInBlock < 0 || txIndexInBlock >= leaves.length) {
    throw new Error(`Tx index ${txIndexInBlock} is out of bounds for a block with ${leaves.length} txs`);
  }

  const tree = await UnbalancedMerkleTreeCalculator.createAsync(
    leaves.map(leaf => leaf.toBuffer()),
    txEffectsTreeNodeHash,
  );

  return {
    root: Fr.fromBuffer(tree.getRoot()),
    leafIndex: BigInt(tree.getLeafLocation(txIndexInBlock).index),
    siblingPath: tree.getSiblingPathByLeafIndex(txIndexInBlock),
  };
}

/**
 * Hashes `leaf` up the witness' sibling path, taking the side of each step from the witness' leaf index (an even index
 * puts the leaf on the left). For a single-tx block the sibling path is empty and the leaf itself is the root.
 *
 * @param leaf - A leaf computed from the tx hash and categories hash by `computeTxEffectsTreeLeaf`, or from the full
 * tx effect by `TxEffect.computeTxEffectsTreeLeaf`. Never accept a bare untrusted leaf: a variable-depth path could
 * otherwise present an internal node as a leaf.
 */
export async function computeRootFromTxEffectMembershipWitness(
  leaf: Fr,
  witness: Pick<TxEffectMembershipWitness, 'leafIndex' | 'siblingPath'>,
): Promise<Fr> {
  const root = await computeRootFromSiblingPath(
    leaf.toBuffer(),
    witness.siblingPath.toBufferArray(),
    Number(witness.leafIndex),
    txEffectsTreeNodeHash,
  );
  return Fr.fromBuffer(root);
}

/**
 * Verifies that a membership witness proves inclusion of `leaf` under `expectedRoot`, which callers must take from a
 * trusted source: the `txEffectsTreeRoot` of the header of block {@link TxEffectMembershipWitness.blockNumber}.
 *
 * @param leaf - A leaf computed from the tx hash and categories hash by `computeTxEffectsTreeLeaf`, or from the full
 * tx effect by `TxEffect.computeTxEffectsTreeLeaf`. Never accept a bare untrusted leaf: a variable-depth path could
 * otherwise present an internal node as a leaf.
 * @returns True iff hashing `leaf` up the sibling path yields `expectedRoot`.
 */
export async function verifyTxEffectMembershipWitness(
  leaf: Fr,
  witness: Pick<TxEffectMembershipWitness, 'leafIndex' | 'siblingPath'>,
  expectedRoot: Fr,
): Promise<boolean> {
  return (await computeRootFromTxEffectMembershipWitness(leaf, witness)).equals(expectedRoot);
}
