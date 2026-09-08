import type { L2Block } from '@aztec-labs/stdlib/block';
import { type TxEffectsTreeData, computeTxEffectsTreeData } from '@aztec-labs/stdlib/tx';

/** Leaves and categories hashes prepared for ingestion, keyed by their owning block hash. */
export type BlockTxEffectsTreeData = ReadonlyMap<string, TxEffectsTreeData>;

/** Prepares tree data before opening a write transaction, reusing hashes already computed during retrieval. */
export async function prepareBlockTxEffectsTreeData(
  blocks: readonly L2Block[],
  precomputed: BlockTxEffectsTreeData = new Map(),
): Promise<BlockTxEffectsTreeData> {
  return new Map(
    await Promise.all(
      blocks.map(async block => {
        const blockHash = (await block.hash()).toString();
        const treeData = precomputed.get(blockHash) ?? (await computeTxEffectsTreeData(block.body.txEffects));
        return [blockHash, treeData] as const;
      }),
    ),
  );
}
