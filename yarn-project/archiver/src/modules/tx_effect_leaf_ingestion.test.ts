import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { BlockHash, L2Block } from '@aztec-labs/stdlib/block';
import { jest } from '@jest/globals';

import { createArchiverDataStores } from '../store/data_stores.js';
import { makeCheckpoint, makePublishedCheckpoint } from '../test/mock_structs.js';
import { ArchiverDataStoreUpdater } from './data_store_updater.js';

describe('tx effect leaf ingestion', () => {
  it('keeps categories hashes in tx order and removes only the replaced block data', async () => {
    const db = await openTmpStore('tx_effect_categories_hashes');
    try {
      const stores = createArchiverDataStores(db, BlockHash.random());
      const hashes: BlockHash[] = [];
      for (const generation of [0, 1]) {
        const block = await L2Block.random(BlockNumber(1), {
          checkpointNumber: CheckpointNumber(1),
          indexWithinCheckpoint: IndexWithinCheckpoint(0),
          txsPerBlock: 3,
          txOptions: { maxEffects: 0, numPublicCallsPerTx: 0 },
        });
        const blockHash = BlockHash.random();
        block.header.setHash(blockHash);
        hashes.push(blockHash);
        const categoriesHashes = block.body.txEffects.map((txEffect, index) => {
          const categoriesHash = new Fr(generation * 10 + index);
          jest.spyOn(txEffect, 'computeTxEffectCategoriesHash').mockResolvedValue(categoriesHash);
          jest.spyOn(txEffect, 'computeTxEffectsTreeLeaf').mockResolvedValue(new Fr(index + 100));
          return categoriesHash;
        });
        await stores.blocks.addProposedBlock(block);
        expect(
          await Promise.all(
            categoriesHashes.map((_, index) => stores.blocks.getTxEffectCategoriesHash(blockHash, index)),
          ),
        ).toEqual(categoriesHashes);
        if (generation === 0) {
          await stores.blocks.removeBlocksAfter(BlockNumber(0));
        }
      }
      expect(await stores.blocks.getTxEffectCategoriesHash(hashes[0], 0)).toBeUndefined();
      expect(await stores.blocks.getTxEffectCategoriesHash(hashes[1], 0)).toEqual(new Fr(10));
    } finally {
      await db.close();
    }
  });

  it.each([
    'store proposed',
    'store checkpoint',
    'store prepared proposed',
    'store prepared checkpoint',
    'updater proposed',
    'updater checkpoint',
    'updater prepared proposed',
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
      const categoriesHash = new Fr(456);
      const computeCategoriesHash = jest
        .spyOn(block.body.txEffects[0], 'computeTxEffectCategoriesHash')
        .mockImplementation(() => {
          if (db.getCurrentWriteTx()) {
            throw new Error('Categories hashing must precede the write transaction');
          }
          return Promise.resolve(categoriesHash);
        });
      const computeLeaf = jest.spyOn(block.body.txEffects[0], 'computeTxEffectsTreeLeaf').mockImplementation(() => {
        if (db.getCurrentWriteTx()) {
          throw new Error('Leaf hashing must precede the write transaction');
        }
        return Promise.resolve(leaf);
      });

      if (route.includes('prepared')) {
        await block.body.computeTxEffectsTreeRoot();
      }

      if (route === 'store proposed' || route === 'store prepared proposed') {
        await stores.blocks.addProposedBlock(block);
      } else if (route === 'store checkpoint' || route === 'store prepared checkpoint') {
        await stores.blocks.addCheckpoints([makePublishedCheckpoint(makeCheckpoint([block]), 10)]);
      } else if (route === 'updater proposed' || route === 'updater prepared proposed') {
        await updater.addProposedBlock(block);
      } else {
        await updater.addCheckpoints([makePublishedCheckpoint(makeCheckpoint([block]), 10)]);
      }

      expect(await stores.blocks.getTxEffectLeaves(blockHash)).toEqual([leaf]);
      expect(await stores.blocks.getTxEffectCategoriesHash(blockHash, 0)).toEqual(categoriesHash);
      expect(await stores.blocks.getTxEffectCategoriesHash(blockHash, 1)).toBeUndefined();
      expect(await stores.blocks.getTxEffectCategoriesHash(BlockHash.random(), 0)).toBeUndefined();
      expect(computeLeaf).toHaveBeenCalledTimes(1);
      expect(computeCategoriesHash).toHaveBeenCalledTimes(1);

      await stores.blocks.removeBlocksAfter(BlockNumber(0));
      expect(await stores.blocks.getTxEffectLeaves(blockHash)).toBeUndefined();
      expect(await stores.blocks.getTxEffectCategoriesHash(blockHash, 0)).toBeUndefined();
    } finally {
      await db.close();
    }
  });
});
