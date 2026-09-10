import { DomainSeparator } from '@aztec-labs/constants';
import { BlockNumber, CheckpointNumber, IndexWithinCheckpoint } from '@aztec-labs/foundation/branded-types';
import { poseidon2HashWithSeparator } from '@aztec-labs/foundation/crypto/poseidon';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { type BlockData, BlockHash, Body } from '@aztec-labs/stdlib/block';
import { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { BlockHeader, TxHash, computeTxEffectLeaves, verifyTxEffectMembershipWitness } from '@aztec-labs/stdlib/tx';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import { TxEffectsTreeResolver, type TxEffectsTreeStoreView } from './tx_effects_tree_resolver.js';

/** Block number every fixture block is served at. */
const BLOCK_NUMBER = BlockNumber(7);

describe('TxEffectsTreeResolver', () => {
  let blocks: MockProxy<TxEffectsTreeStoreView>;
  let resolver: TxEffectsTreeResolver;

  beforeEach(() => {
    blocks = mock<TxEffectsTreeStoreView>();
    resolver = new TxEffectsTreeResolver(blocks);
  });

  it('returns undefined for a tx the archiver does not know', async () => {
    blocks.getTxLocation.mockResolvedValue(undefined);
    expect(await resolver.getTxEffectMembershipWitness(TxHash.random())).toBeUndefined();
  });

  describe('consistent reads', () => {
    const root = new Fr(123);
    let txHash: TxHash;
    let blockData: BlockData;

    beforeEach(() => {
      txHash = TxHash.random();
      blockData = makeBlockData(root);
      blocks.getTxLocation.mockResolvedValue({
        blockNumber: BLOCK_NUMBER,
        blockHash: blockData.blockHash,
        txIndexInBlock: 0,
      });
      blocks.getBlockData.mockResolvedValue(blockData);
      blocks.getTxEffectCategoriesHash.mockImplementation((hash, index) =>
        Promise.resolve(hash.equals(blockData.blockHash) && index === 0 ? new Fr(456) : undefined),
      );
      blocks.getTxEffectLeaves.mockImplementation(hash =>
        Promise.resolve(hash.equals(blockData.blockHash) ? [root] : undefined),
      );
    });

    it('returns the stored categories hash for the indexed transaction', async () => {
      blocks.getTxEffectCategoriesHash.mockResolvedValue(new Fr(456));
      const witness = await resolver.getTxEffectMembershipWitness(txHash);
      expect(witness?.categoriesHash).toEqual(new Fr(456));
    });

    it.each(['getBlockData', 'getTxEffectLeaves', 'getTxEffectCategoriesHash'] as const)(
      'retries when %s temporarily returns no data',
      async method => {
        blocks[method].mockResolvedValueOnce(undefined);

        const witness = await resolver.getTxEffectMembershipWitness(txHash);

        expect(witness?.root).toEqual(root);
        expect(witness?.leafIndex).toBe(0n);
        expect(witness?.siblingPath.pathSize).toBe(0);
      },
    );

    it.each(['success', 'failure'])('waits 50ms between retries ending in %s', async outcome => {
      jest.useFakeTimers();
      try {
        const start = Date.now();
        const attemptTimes: number[] = [];
        blocks.getTxLocation.mockImplementation(() => {
          attemptTimes.push(Date.now() - start);
          return Promise.resolve({ blockNumber: BLOCK_NUMBER, blockHash: blockData.blockHash, txIndexInBlock: 0 });
        });
        blocks.getTxEffectLeaves.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
        if (outcome === 'failure') {
          blocks.getTxEffectLeaves.mockResolvedValue(undefined);
        }

        const lookup = resolver.getTxEffectMembershipWitness(txHash);
        const result =
          outcome === 'success'
            ? expect(lookup).resolves.toMatchObject({ root })
            : expect(lookup).rejects.toThrow('after 3 attempts');
        await Promise.all([result, jest.runAllTimersAsync()]);

        expect(attemptTimes).toEqual([0, 50, 100]);
        expect(Date.now() - start).toBe(100);
      } finally {
        jest.useRealTimers();
      }
    });

    it('can succeed on the third attempt', async () => {
      blocks.getTxEffectLeaves.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

      const witness = await resolver.getTxEffectMembershipWitness(txHash);

      expect(witness?.root).toEqual(root);
      expect(blocks.getTxLocation).toHaveBeenCalledTimes(3);
    });

    it('retries when the header hash does not match the indexed block', async () => {
      blocks.getBlockData.mockResolvedValueOnce(makeBlockData(new Fr(456)));

      const witness = await resolver.getTxEffectMembershipWitness(txHash);

      expect(witness?.root).toEqual(root);
      expect(blocks.getTxLocation).toHaveBeenCalledTimes(2);
    });

    it('uses the updated transaction location on retry', async () => {
      const newBlockNumber = BlockNumber(8);
      blocks.getTxLocation
        .mockResolvedValueOnce({ blockNumber: BLOCK_NUMBER, blockHash: BlockHash.random(), txIndexInBlock: 1 })
        .mockResolvedValue({ blockNumber: newBlockNumber, blockHash: blockData.blockHash, txIndexInBlock: 0 });
      blocks.getBlockData.mockImplementation(({ number }) =>
        Promise.resolve(number === newBlockNumber ? blockData : makeBlockData(new Fr(456))),
      );

      const witness = await resolver.getTxEffectMembershipWitness(txHash);

      expect(witness?.blockNumber).toBe(newBlockNumber);
      expect(witness?.root).toEqual(root);
      expect(witness?.leafIndex).toBe(0n);
    });

    it('returns undefined when the transaction disappears during retry', async () => {
      blocks.getTxLocation
        .mockResolvedValueOnce({ blockNumber: BLOCK_NUMBER, blockHash: blockData.blockHash, txIndexInBlock: 0 })
        .mockResolvedValue(undefined);
      blocks.getTxEffectLeaves.mockResolvedValueOnce(undefined);

      expect(await resolver.getTxEffectMembershipWitness(txHash)).toBeUndefined();
    });

    it.each(['missing block', 'hash mismatch', 'missing leaves', 'missing categories hash'])(
      'fails after three attempts with %s',
      async condition => {
        if (condition === 'missing block') {
          blocks.getBlockData.mockResolvedValue(undefined);
        } else if (condition === 'hash mismatch') {
          blocks.getBlockData.mockResolvedValue(makeBlockData(root));
        } else if (condition === 'missing categories hash') {
          blocks.getTxEffectCategoriesHash.mockResolvedValue(undefined);
        } else {
          blocks.getTxEffectLeaves.mockResolvedValue(undefined);
        }

        await expect(resolver.getTxEffectMembershipWitness(txHash)).rejects.toThrow('after 3 attempts');
        expect(blocks.getTxLocation).toHaveBeenCalledTimes(3);
      },
    );

    it('throws without retrying when stored leaves do not match the header root', async () => {
      blocks.getTxEffectLeaves.mockResolvedValue([new Fr(456)]);

      await expect(resolver.getTxEffectMembershipWitness(txHash)).rejects.toThrow('does not match its header');
      expect(blocks.getTxLocation).toHaveBeenCalledTimes(1);
    });

    it('throws without retrying when the transaction index is outside the stored leaves', async () => {
      blocks.getTxLocation.mockResolvedValue({
        blockNumber: BLOCK_NUMBER,
        blockHash: blockData.blockHash,
        txIndexInBlock: 1,
      });

      await expect(resolver.getTxEffectMembershipWitness(txHash)).rejects.toThrow('out of bounds');
      expect(blocks.getTxLocation).toHaveBeenCalledTimes(1);
    });

    it('propagates database errors without retrying', async () => {
      const error = new Error('Store is closed');
      blocks.getBlockData.mockRejectedValue(error);

      await expect(resolver.getTxEffectMembershipWitness(txHash)).rejects.toBe(error);
      expect(blocks.getTxLocation).toHaveBeenCalledTimes(1);
    });
  });

  it('builds a verifiable witness for every tx of a multi-tx block', async () => {
    const body = await makeBody(3);
    const root = await wireStore(blocks, body);

    for (const txEffect of body.txEffects) {
      const witness = await resolver.getTxEffectMembershipWitness(txEffect.txHash);
      expect(witness).toBeDefined();
      expect(witness!.blockNumber).toBe(BLOCK_NUMBER);
      expect(witness!.root).toEqual(root);
      expect(witness!.categoriesHash).toEqual(await txEffect.computeTxEffectCategoriesHash());
      expect(await verifyTxEffectMembershipWitness(await txEffect.computeTxEffectsTreeLeaf(), witness!, root)).toBe(
        true,
      );
    }
  });

  // The tree is greedily filled, so a 3-leaf tree pairs the first two leaves and shifts the last one up a level.
  it('yields per-leaf path depths matching the unbalanced tree shape', async () => {
    const body = await makeBody(3);
    await wireStore(blocks, body);

    const witnesses = await Promise.all(
      body.txEffects.map(txEffect => resolver.getTxEffectMembershipWitness(txEffect.txHash)),
    );

    expect(witnesses.map(w => w!.siblingPath.pathSize)).toEqual([2, 2, 1]);
    expect(witnesses.map(w => w!.leafIndex)).toEqual([0n, 1n, 1n]);
  });

  it('builds an empty witness for a single-tx block', async () => {
    const body = await makeBody(1);
    const root = await wireStore(blocks, body);

    const witness = await resolver.getTxEffectMembershipWitness(body.txEffects[0].txHash);
    expect(witness!.siblingPath.pathSize).toBe(0);
    expect(witness!.leafIndex).toBe(0n);
    expect(witness!.root).toEqual(root);
    expect(root).toEqual(await body.txEffects[0].computeTxEffectsTreeLeaf());
  });

  // Serves a second leaf that does not match the second tx's effects, so a resolver that recomputed the leaves from the
  // block body instead of reading the stored ones would build a different tree and fail the header root check.
  it('builds the witness from the stored leaves rather than recomputing them from the block', async () => {
    const body = await makeBody(2);
    const storedLeaves = [await body.txEffects[0].computeTxEffectsTreeLeaf(), Fr.random()];
    const root = await wireStore(blocks, body, await hashPair(storedLeaves[0], storedLeaves[1]));
    blocks.getTxEffectLeaves.mockResolvedValue(storedLeaves);

    const witness = await resolver.getTxEffectMembershipWitness(body.txEffects[0].txHash);

    expect(witness!.root).toEqual(root);
    expect(witness!.siblingPath.toFields()).toEqual([storedLeaves[1]]);
  });
});

function makeBody(txsPerBlock: number): Promise<Body> {
  return Body.random({ txsPerBlock, maxEffects: 1, numPublicCallsPerTx: 1 });
}

/**
 * Wires the store view to serve a single block holding `body`: the block's header, its stored tx effects tree leaves,
 * and each of its txs indexed by position. Returns the root the block header commits to, which is the body's own root
 * unless `headerRoot` overrides it.
 */
async function wireStore(blocks: MockProxy<TxEffectsTreeStoreView>, body: Body, headerRoot?: Fr): Promise<Fr> {
  const txEffectsTreeRoot = headerRoot ?? (await body.computeTxEffectsTreeRoot());
  const blockData = makeBlockData(txEffectsTreeRoot);
  blocks.getBlockData.mockResolvedValue(blockData);
  blocks.getTxEffectLeaves.mockResolvedValue(await computeTxEffectLeaves(body.txEffects));
  blocks.getTxEffectCategoriesHash.mockImplementation(
    (_hash, index) => body.txEffects[index]?.computeTxEffectCategoriesHash() ?? Promise.resolve(undefined),
  );
  blocks.getTxLocation.mockImplementation((txHash: TxHash) => {
    const txIndexInBlock = body.txEffects.findIndex(txEffect => txEffect.txHash.equals(txHash));
    if (txIndexInBlock === -1) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({ blockNumber: BLOCK_NUMBER, blockHash: blockData.blockHash, txIndexInBlock });
  });
  return txEffectsTreeRoot;
}

/** Hashes a pair of nodes the way the tx effects tree does. */
function hashPair(left: Fr, right: Fr): Promise<Fr> {
  return poseidon2HashWithSeparator([left, right], DomainSeparator.TX_EFFECTS_TREE);
}

function makeBlockData(txEffectsTreeRoot: Fr, blockHash = BlockHash.random()): BlockData {
  return {
    header: BlockHeader.empty({ txEffectsTreeRoot }),
    archive: AppendOnlyTreeSnapshot.empty(),
    blockHash,
    checkpointNumber: CheckpointNumber(1),
    indexWithinCheckpoint: IndexWithinCheckpoint(0),
  };
}
