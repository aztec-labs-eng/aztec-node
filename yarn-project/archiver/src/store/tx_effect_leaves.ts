import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { L2Block } from '@aztec-labs/stdlib/block';
import { computeTxEffectLeaves } from '@aztec-labs/stdlib/tx';

/** Leaves prepared for ingestion, keyed by the hash of the block they belong to. */
export type BlockTxEffectLeaves = ReadonlyMap<string, readonly Fr[]>;

/** Prepares leaves before opening a write transaction, reusing any leaves already computed during retrieval. */
export async function prepareBlockTxEffectLeaves(
  blocks: readonly L2Block[],
  precomputed: BlockTxEffectLeaves = new Map(),
): Promise<BlockTxEffectLeaves> {
  return new Map(
    await Promise.all(
      blocks.map(async block => {
        const blockHash = (await block.hash()).toString();
        const leaves = precomputed.get(blockHash) ?? (await computeTxEffectLeaves(block.body.txEffects));
        return [blockHash, leaves] as const;
      }),
    ),
  );
}
