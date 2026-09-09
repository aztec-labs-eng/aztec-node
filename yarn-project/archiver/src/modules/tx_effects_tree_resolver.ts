import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import { sleep } from '@aztec-labs/foundation/sleep';
import type { BlockData, BlockHash } from '@aztec-labs/stdlib/block';
import {
  type TxEffectMembershipWitness,
  type TxHash,
  computeTxEffectMembershipWitnessFromLeaves,
} from '@aztec-labs/stdlib/tx';

import type { TxLocation } from '../store/block_store.js';

/**
 * Store-side view of the data the resolver needs to assemble a witness. The archiver block store holds each of these
 * natively, so no L2 RPC plumbing is required.
 */
export interface TxEffectsTreeStoreView {
  /** Reads the block currently stored at the requested height. */
  getBlockData(query: { number: BlockNumber }): Promise<BlockData | undefined>;
  /** Reads the owning block and transaction index from the same stored entry. */
  getTxLocation(txHash: TxHash): Promise<TxLocation | undefined>;
  /** Reads the leaves belonging to the given block hash. */
  getTxEffectLeaves(blockHash: BlockHash): Promise<Fr[] | undefined>;
  /** Reads the categories hash for the transaction in its owning block. */
  getTxEffectCategoriesHash(blockHash: BlockHash, txIndexInBlock: number): Promise<Fr | undefined>;
}

/**
 * Builds membership witnesses against a block's tx effects tree root.
 *
 * No tree is cached: only the leaves and categories hashes, computed once when the store ingests a block. Per
 * request, the internal nodes are rebuilt from those leaves (one cheap two-field hash per tx) and the rebuilt root is
 * checked against the root the block header commits to.
 */
export class TxEffectsTreeResolver {
  constructor(
    private readonly blocks: TxEffectsTreeStoreView,
    private readonly log: Logger = createLogger('archiver:tx_effects_tree'),
  ) {}

  /**
   * Builds the membership witness proving that `txHash` was included in its block and produced exactly the effects the
   * archiver stores for it. Returns `undefined` if the tx is not in a block the archiver knows about.
   *
   * Throws if the stored leaves do not hash up to the root in the block header, which would mean the stored block is
   * corrupted. Retries inconsistent or missing block data up to three total attempts, 50ms apart, then throws.
   */
  public async getTxEffectMembershipWitness(txHash: TxHash): Promise<TxEffectMembershipWitness | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(50);
      }

      const location = await this.blocks.getTxLocation(txHash);
      if (!location) {
        this.log.trace(`No tx effect for tx, no witness available`, { txHash });
        return undefined;
      }

      const { blockNumber, blockHash, txIndexInBlock } = location;
      const blockData = await this.blocks.getBlockData({ number: blockNumber });
      if (!blockData || !blockData.blockHash.equals(blockHash)) {
        this.log.debug(`Block no longer matches the tx location, retrying witness lookup`, {
          txHash,
          blockNumber,
          blockHash,
          actualBlockHash: blockData?.blockHash,
          attempt,
        });
        continue;
      }

      // Hash-keyed leaves bind this read to the index and header even if the block at this height changes.
      const leaves = await this.blocks.getTxEffectLeaves(blockHash);
      if (!leaves) {
        this.log.debug(`Tx effects tree leaves are no longer available, retrying witness lookup`, {
          txHash,
          blockNumber,
          blockHash,
          attempt,
        });
        continue;
      }

      const { root, leafIndex, siblingPath } = await computeTxEffectMembershipWitnessFromLeaves(leaves, txIndexInBlock);
      if (!root.equals(blockData.header.txEffectsTreeRoot)) {
        throw new Error(
          `Tx effects tree root rebuilt from the stored leaves of block ${blockNumber} does not match its header: ` +
            `rebuilt=${root} header=${blockData.header.txEffectsTreeRoot}`,
        );
      }

      const categoriesHash = await this.blocks.getTxEffectCategoriesHash(blockHash, txIndexInBlock);
      if (!categoriesHash) {
        this.log.debug(`Tx effect categories hash is no longer available, retrying witness lookup`, {
          txHash,
          blockNumber,
          blockHash,
          attempt,
        });
        continue;
      }

      return { blockNumber, root, categoriesHash, leafIndex, siblingPath };
    }

    throw new Error(`Could not read consistent tx effects tree data for tx ${txHash} after 3 attempts`);
  }
}
