import type { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type Logger, createLogger } from '@aztec-labs/foundation/log';
import type { AztecAsyncKVStore } from '@aztec-labs/kv-store';
import type { BlockData } from '@aztec-labs/stdlib/block';
import {
  type TxEffectMembershipWitness,
  type TxHash,
  computeTxEffectMembershipWitnessFromLeaves,
} from '@aztec-labs/stdlib/tx';

/**
 * Store-side view of the data the resolver needs to assemble a witness. The archiver block store holds each of these
 * natively, so no L2 RPC plumbing is required.
 */
export interface TxEffectsTreeStoreView {
  getBlockData(query: { number: BlockNumber }): Promise<BlockData | undefined>;
  getTxLocation(txHash: TxHash): Promise<[blockNumber: BlockNumber, txIndexInBlock: number] | undefined>;
  getTxEffectLeaves(blockNumber: BlockNumber): Promise<Fr[] | undefined>;
}

/**
 * Builds membership witnesses against a block's tx effects tree root.
 *
 * No tree is cached: only the tx effects tree leaves are, computed once per block when the store ingests it. Per
 * request, the internal nodes are rebuilt from those leaves (one cheap two-field hash per tx) and the rebuilt root is
 * checked against the root the block header commits to.
 */
export class TxEffectsTreeResolver {
  constructor(
    private readonly blocks: TxEffectsTreeStoreView,
    private readonly store: AztecAsyncKVStore,
    private readonly log: Logger = createLogger('archiver:tx_effects_tree'),
  ) {}

  /**
   * Builds the membership witness proving that `txHash` was included in its block and produced exactly the effects the
   * archiver stores for it. Returns `undefined` if the tx is not in a block the archiver knows about.
   *
   * Throws if the stored leaves do not hash up to the root in the block header, which would mean the stored block is
   * corrupted.
   */
  public async getTxEffectMembershipWitness(txHash: TxHash): Promise<TxEffectMembershipWitness | undefined> {
    const snapshot = await this.store.transactionAsync(async () => {
      const location = await this.blocks.getTxLocation(txHash);
      if (!location) {
        this.log.trace(`No tx effect for tx, no witness available`, { txHash });
        return undefined;
      }

      const [blockNumber, txIndexInBlock] = location;
      const blockData = await this.blocks.getBlockData({ number: blockNumber });
      if (!blockData) {
        this.log.trace(`No block for tx, no witness available`, { txHash, blockNumber });
        return undefined;
      }

      const leaves = await this.blocks.getTxEffectLeaves(blockNumber);
      if (!leaves) {
        throw new Error(`No tx effects tree leaves stored for block ${blockNumber} holding tx ${txHash}`);
      }

      return { blockNumber, txIndexInBlock, blockData, leaves };
    });

    if (!snapshot) {
      return undefined;
    }

    const { blockNumber, txIndexInBlock, blockData, leaves } = snapshot;
    const { root, leafIndex, siblingPath } = await computeTxEffectMembershipWitnessFromLeaves(leaves, txIndexInBlock);
    if (!root.equals(blockData.header.txEffectsTreeRoot)) {
      throw new Error(
        `Tx effects tree root rebuilt from the stored leaves of block ${blockNumber} does not match its header: ` +
          `rebuilt=${root} header=${blockData.header.txEffectsTreeRoot}`,
      );
    }

    return { blockNumber, root, leafIndex, siblingPath };
  }
}
