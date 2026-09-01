import { DomainSeparator } from '@aztec-labs/constants';
import { type BlockNumber, BlockNumberSchema } from '@aztec-labs/foundation/branded-types';
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

/**
 * Hasher for the internal nodes of a block's tx effects tree. Must match the accumulation the rollup circuits perform
 * up the tx rollup tree.
 */
export const txEffectsTreeNodeHash = makePoseidonMerkleHash(DomainSeparator.TX_EFFECTS_TREE);

/**
 * Proof that a tx was included in a block and produced exactly the effects the block reports for it.
 *
 * The witness is verified against `BlockHeader.txEffectsTreeRoot` of block {@link blockNumber} by hashing the tx's leaf
 * (`TxEffect.computeTxEffectLeaf`, which binds the tx hash to the hash of its effects) up the sibling path.
 */
export type TxEffectMembershipWitness = {
  /** Block the tx was included in, whose header carries the root this witness is built against. */
  blockNumber: BlockNumber;
  /** Root of the block's tx effects tree, equal to `BlockHeader.txEffectsTreeRoot`. */
  root: Fr;
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
  leafIndex: schemas.BigInt,
  siblingPath: SiblingPath.schema,
}) as unknown as z.ZodType<TxEffectMembershipWitness>;

/**
 * Computes the leaves of a block's tx effects tree, in block order. Each leaf is an expensive structured hash over the
 * tx's full effect data, so callers that need the leaves more than once should keep them around.
 *
 * @param txEffects - All tx effects of the block, in block order.
 */
export function computeTxEffectLeaves(txEffects: TxEffect[]): Promise<Fr[]> {
  return Promise.all(txEffects.map(txEffect => txEffect.computeTxEffectLeaf()));
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
  return await computeTxEffectMembershipWitnessFromLeaves(await computeTxEffectLeaves(txEffects), txIndexInBlock);
}

/**
 * Rebuilds a block's tx effects tree from its precomputed leaves and returns the membership witness for the tx at
 * `txIndexInBlock`. The returned root must be checked against the block header's `txEffectsTreeRoot` by the caller.
 *
 * Only the internal nodes are hashed here (one cheap two-field hash per tx), so this is the cheap path for callers
 * that already hold the leaves.
 *
 * @param leaves - Leaves of the block's tx effects tree, in block order.
 * @param txIndexInBlock - Index within the block of the tx to prove.
 */
export async function computeTxEffectMembershipWitnessFromLeaves(
  leaves: Fr[],
  txIndexInBlock: number,
): Promise<Omit<TxEffectMembershipWitness, 'blockNumber'>> {
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
 * @param leaf - The tx's leaf, as computed by `TxEffect.computeTxEffectLeaf`.
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
 * @param leaf - The tx's leaf, as computed by `TxEffect.computeTxEffectLeaf`.
 * @returns True iff hashing `leaf` up the sibling path yields `expectedRoot`.
 */
export async function verifyTxEffectMembershipWitness(
  leaf: Fr,
  witness: Pick<TxEffectMembershipWitness, 'leafIndex' | 'siblingPath'>,
  expectedRoot: Fr,
): Promise<boolean> {
  return (await computeRootFromTxEffectMembershipWitness(leaf, witness)).equals(expectedRoot);
}
