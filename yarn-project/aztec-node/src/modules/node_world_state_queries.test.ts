import { ARCHIVE_HEIGHT } from '@aztec-labs/constants';
import {
  BlockNumber,
  CheckpointNumber,
  IndexWithinCheckpoint,
  TreeLeafIndex,
} from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { MembershipWitness } from '@aztec-labs/foundation/trees';
import {
  type ArchiveBlockParameter,
  type BlockData,
  BlockHash,
  type BlockParameter,
  type BlockQuery,
  type L2Block,
  type L2BlockSource,
} from '@aztec-labs/stdlib/block';
import { computeMerkleHash } from '@aztec-labs/stdlib/hash';
import type { L1ToL2MessageSource } from '@aztec-labs/stdlib/messaging';
import { AppendOnlyTreeSnapshot, MerkleTreeId } from '@aztec-labs/stdlib/trees';
import { BlockHeader } from '@aztec-labs/stdlib/tx';
import { NativeWorldStateService, ServerWorldStateSynchronizer, type WorldStateConfig } from '@aztec-labs/world-state';
import { mockBlock } from '@aztec-labs/world-state/test';
import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';

import { NodeWorldStateQueries } from './node_world_state_queries.js';
import { UnseenBlockHoldOff } from './unseen_block_hold_off.js';

jest.setTimeout(60_000);

/** Recomputes the archive root a witness for `leaf` proves membership under. */
async function rootOf(witness: MembershipWitness<typeof ARCHIVE_HEIGHT>, leaf: BlockHash): Promise<Fr> {
  let node = Fr.fromBuffer(leaf.toBuffer());
  let index = witness.leafIndex;
  for (const sibling of witness.siblingPath) {
    node = index & 1n ? await computeMerkleHash(sibling, node) : await computeMerkleHash(node, sibling);
    index >>= 1n;
  }
  return node;
}

describe('NodeWorldStateQueries archive membership witnesses', () => {
  const TIP = BlockNumber(3);

  let worldStateDb: NativeWorldStateService;
  let blockSource: MockProxy<L2BlockSource & L1ToL2MessageSource>;
  let queries: NodeWorldStateQueries;

  let initialHeader: BlockHeader;
  let genesisHash: BlockHash;
  /** Post-genesis archive root: the archive holding just the initial header hash. */
  let genesisArchive: Fr;
  /** Blocks 1 through {@link TIP}, indexed by block number (index 0 unused). */
  let blocks: L2Block[];
  let hashes: BlockHash[];
  /** Headers the block source reports, by block number; a test may swap one to stand in for another fork's block. */
  let headers: BlockHeader[];

  const blockDataAt = (blockNumber: number): BlockData => ({
    header: headers[blockNumber],
    archive:
      blockNumber === 0 ? new AppendOnlyTreeSnapshot(genesisArchive, TreeLeafIndex(1)) : blocks[blockNumber].archive,
    blockHash: hashes[blockNumber],
    checkpointNumber: CheckpointNumber(1),
    indexWithinCheckpoint: IndexWithinCheckpoint(0),
  });

  /** Mirrors the archiver's resolution, including mapping the post-genesis archive root to block 0. */
  const resolve = (query: BlockQuery): BlockData | undefined => {
    const all = Array.from({ length: TIP + 1 }, (_, n) => blockDataAt(n));
    if ('number' in query) {
      return all.find(d => d.header.getBlockNumber() === query.number);
    }
    if ('hash' in query) {
      return all.find(d => d.blockHash.equals(query.hash));
    }
    if ('archive' in query) {
      return all.find(d => d.archive.root.equals(query.archive));
    }
    return blockDataAt(TIP);
  };

  beforeAll(async () => {
    worldStateDb = await NativeWorldStateService.tmp();
    initialHeader = worldStateDb.getInitialHeader();
    genesisHash = await initialHeader.hash();
    genesisArchive = Fr.fromBuffer((await worldStateDb.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).root);

    blocks = [];
    hashes = [genesisHash];
    const fork = await worldStateDb.fork();
    for (let n = 1; n <= TIP; n++) {
      const { block, messages } = await mockBlock(BlockNumber(n), 1, fork, 1, 0, true);
      await worldStateDb.handleL2BlockAndMessages(block, messages);
      blocks[n] = block;
      hashes[n] = await block.hash();
    }
    await fork.close();
  });

  afterAll(async () => {
    await worldStateDb.close();
  });

  beforeEach(() => {
    headers = [initialHeader, ...blocks.slice(1).map(b => b.header)];

    blockSource = mock<L2BlockSource & L1ToL2MessageSource>();
    blockSource.getBlockData.mockImplementation((query: BlockQuery) => Promise.resolve(resolve(query)));
    blockSource.getBlockNumber.mockResolvedValue(TIP);
    blockSource.getGenesisBlockHash.mockImplementation(() => genesisHash);

    const synchronizer = new ServerWorldStateSynchronizer(worldStateDb, blockSource, {
      worldStateBlockCheckIntervalMS: 100,
    } as WorldStateConfig);
    // Every block is already committed, so the barrier the node syncs through has nothing to wait for.
    jest.spyOn(synchronizer, 'syncImmediate').mockResolvedValue(TIP);

    queries = new NodeWorldStateQueries({
      worldStateSynchronizer: synchronizer,
      blockSource,
      l1ToL2MessageSource: blockSource,
      holdOff: new UnseenBlockHoldOff(blockSource, { byNumberWaitMs: 0, byHashWaitMs: 0 }),
    });
  });

  describe('getBlockHashMembershipWitness', () => {
    it.each<[string, () => BlockParameter]>([
      ['a bare number', () => BlockNumber(3)],
      ['a bare hash', () => hashes[3]],
      ['a tag', () => 'latest'],
      ['{ number }', () => ({ number: BlockNumber(3) })],
      ['{ hash }', () => ({ hash: hashes[3] })],
      ['{ tag }', () => ({ tag: 'proposed' })],
      ['{ number, hash }', () => ({ number: BlockNumber(3), hash: hashes[3] })],
      ['{ archive } naming the block by its own archive', () => ({ archive: blocks[3].archive.root })],
    ])('proves against the reference header lastArchive when selected by %s', async (_, selector) => {
      const witness = await queries.getBlockHashMembershipWitness(selector(), hashes[1]);

      expect(witness).toBeDefined();
      expect(witness!.leafIndex).toEqual(1n);
      expect(await rootOf(witness!, hashes[1])).toEqual(blocks[3].header.lastArchive.root);
    });

    it('does not find the reference block itself, which its lastArchive predates', async () => {
      expect(await queries.getBlockHashMembershipWitness(BlockNumber(3), hashes[3])).toBeUndefined();
    });

    it('returns undefined for a block hash absent from the archive', async () => {
      expect(await queries.getBlockHashMembershipWitness(BlockNumber(3), BlockHash.random())).toBeUndefined();
    });

    it('rejects a reference block past the tip, even though the archive it would commit to is available', async () => {
      await expect(queries.getBlockHashMembershipWitness(BlockNumber(TIP + 1), hashes[TIP])).rejects.toThrow(
        /Block not found for number=4/,
      );
      await expect(
        queries.getBlockHashMembershipWitness({ number: BlockNumber(TIP + 1) }, hashes[TIP]),
      ).rejects.toThrow(/Block not found for number=4/);
    });

    it('proves the genesis block hash against block 1 lastArchive', async () => {
      const witness = await queries.getBlockHashMembershipWitness(BlockNumber(1), genesisHash);

      expect(witness!.leafIndex).toEqual(0n);
      expect(await rootOf(witness!, genesisHash)).toEqual(blocks[1].header.lastArchive.root);
      expect(blocks[1].header.lastArchive.root).toEqual(genesisArchive);
    });

    it('returns undefined against the initial header, whose lastArchive is empty', async () => {
      expect(await queries.getBlockHashMembershipWitness(genesisHash, genesisHash)).toBeUndefined();
    });

    it('rejects rather than answers when the predecessor snapshot holds another archive', async () => {
      // The reference header resolves on one fork while world state holds another at the block before: the
      // header's lastArchive is not the archive world state can prove against.
      headers[3] = BlockHeader.from({
        ...blocks[3].header,
        lastArchive: new AppendOnlyTreeSnapshot(Fr.random(), blocks[3].header.lastArchive.nextAvailableLeafIndex),
      });

      await expect(queries.getBlockHashMembershipWitness(BlockNumber(3), hashes[1])).rejects.toThrow(
        /is not available/,
      );
    });
  });

  describe('getBlockHashMembershipWitnessAtArchive', () => {
    it('proves a block against its own archive at an idle tip, with no successor block', async () => {
      const archive = blocks[TIP].archive.root;

      const witness = await queries.getBlockHashMembershipWitnessAtArchive({ archive }, hashes[TIP]);

      expect(witness!.leafIndex).toEqual(BigInt(TIP));
      expect(await rootOf(witness!, hashes[TIP])).toEqual(archive);
    });

    it('proves an earlier block against a historical archive', async () => {
      const archive = blocks[2].archive.root;

      const witness = await queries.getBlockHashMembershipWitnessAtArchive({ archive }, hashes[1]);

      expect(witness!.leafIndex).toEqual(1n);
      expect(await rootOf(witness!, hashes[1])).toEqual(archive);
    });

    it('returns undefined for a block hash absent from the archive', async () => {
      const archive = blocks[2].archive.root;

      expect(await queries.getBlockHashMembershipWitnessAtArchive({ archive }, hashes[3])).toBeUndefined();
    });

    it('proves the genesis block hash against the post-genesis archive', async () => {
      const witness = await queries.getBlockHashMembershipWitnessAtArchive({ archive: genesisArchive }, genesisHash);

      expect(witness!.leafIndex).toEqual(0n);
      expect(await rootOf(witness!, genesisHash)).toEqual(genesisArchive);
    });

    it('rejects an archive root the node does not know', async () => {
      await expect(queries.getBlockHashMembershipWitnessAtArchive({ archive: Fr.random() }, hashes[1])).rejects.toThrow(
        /not found when resolving query/,
      );
    });

    it('resolves by the archive even when handed another selector alongside it', async () => {
      const archive = blocks[2].archive.root;
      const reference = { archive, number: BlockNumber(3) } as ArchiveBlockParameter;

      const witness = await queries.getBlockHashMembershipWitnessAtArchive(reference, hashes[1]);

      expect(await rootOf(witness!, hashes[1])).toEqual(archive);
    });
  });
});
