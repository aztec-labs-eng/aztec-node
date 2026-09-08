import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { BlockHash, L2Block } from '@aztec-labs/stdlib/block';
import { jest } from '@jest/globals';

import { createArchiverDataStores } from '../store/data_stores.js';
import { makeCheckpoint, makePublishedCheckpoint } from '../test/mock_structs.js';
import { ArchiverDataStoreUpdater } from './data_store_updater.js';

describe('tx effect leaf ingestion', () => {
  it.each([
    'store proposed',
    'store checkpoint',
    'updater proposed',
    'updater checkpoint',
    'updater prepared checkpoint',
  ])('hashes each effect once before the write transaction for %s', async route => {
    const db = await openTmpStore('tx_effect_leaf_ingestion');
    try {
      const stores = createArchiverDataStores(db, BlockHash.random());
      const updater = new ArchiverDataStoreUpdater(stores);
      const block = await L2Block.random(BlockNumber(1), {
        checkpointNumber: CheckpointNumber(1),
        indexWithinCheckpoint: IndexWithinCheckpoint(0),
        txsPerBlock: 1,
        txOptions: { maxEffects: 0, numPublicCallsPerTx: 0 },
      });
      const blockHash = BlockHash.random();
      block.header.setHash(blockHash);
      const leaf = new Fr(123);
      const computeLeaf = jest.spyOn(block.body.txEffects[0], 'computeTxEffectsTreeLeaf').mockImplementation(() => {
        if (db.getCurrentWriteTx()) {
          throw new Error('Leaf hashing must precede the write transaction');
        }
        return Promise.resolve(leaf);
      });

      if (route === 'store proposed') {
        await stores.blocks.addProposedBlock(block);
      } else if (route === 'store checkpoint') {
        await stores.blocks.addCheckpoints([makePublishedCheckpoint(makeCheckpoint([block]), 10)]);
      } else if (route === 'updater proposed') {
        await updater.addProposedBlock(block);
      } else if (route === 'updater prepared checkpoint') {
        const { leaves } = await block.body.computeTxEffectsTree();
        await updater.addCheckpoints(
          [makePublishedCheckpoint(makeCheckpoint([block]), 10)],
          undefined,
          undefined,
          undefined,
          new Map([[blockHash.toString(), leaves]]),
        );
      } else {
        await updater.addCheckpoints([makePublishedCheckpoint(makeCheckpoint([block]), 10)]);
      }

      expect(await stores.blocks.getTxEffectLeaves(blockHash)).toEqual([leaf]);
      expect(computeLeaf).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });
});
