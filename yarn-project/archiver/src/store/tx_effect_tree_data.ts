import type { L2Block } from '@aztec-labs/stdlib/block';

/** Prepares tree data before opening a write transaction, reusing hashes already computed during retrieval. */
export async function prepareBlockTxEffectsTreeData(blocks: readonly L2Block[]): Promise<void> {
  await Promise.all(blocks.flatMap(block => [block.hash(), block.body.computeTxEffectsTreeData()]));
}
