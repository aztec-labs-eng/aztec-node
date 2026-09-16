import { BlockNumber, TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonStringify } from '@aztec-labs/foundation/json-rpc';

import { BlockHeader } from '../tx/block_header.js';
import { GENESIS_BLOCK_HEADER_HASH } from './block_hash.js';
import { L2Block } from './l2_block.js';

describe('L2Block', () => {
  it('can serialize an L2 block with logs to a buffer and back', async () => {
    const block = await L2Block.random(BlockNumber(42));

    const buffer = block.toBuffer();
    const recovered = L2Block.fromBuffer(buffer);

    expect(recovered).toEqual(block);
  });

  it('convert to and from json', async () => {
    const block = await L2Block.random(BlockNumber(42));
    const parsed = L2Block.schema.parse(JSON.parse(jsonStringify(block)));
    expect(parsed).toEqual(block);
  });

  it('can create an initial block', async () => {
    // Values taken from world_state.test.cpp WorldStateTest.GetInitialTreeInfoForAllTrees
    const emptyBlockHeader = BlockHeader.empty();
    emptyBlockHeader.state.l1ToL2MessageTree.root = Fr.fromString(
      '0x0fef6d80d31109ddb56d6b3f607cbc9c0af0bff3ea0d43e8f278983c64c11f7a',
    );
    emptyBlockHeader.state.partial.noteHashTree.root = Fr.fromString(
      '0x2590f2aab19dd791700b4a43d3f52bb88ef2409a3731da8e848663559202e4c6',
    );
    emptyBlockHeader.state.partial.nullifierTree.root = Fr.fromString(
      '0x21a19fe6f636fb24d9f63edb7b807613492cc0001c91e531917a2539f57e2ba8',
    );
    emptyBlockHeader.state.partial.nullifierTree.nextAvailableLeafIndex = TreeLeafIndex(128);
    emptyBlockHeader.state.partial.publicDataTree.root = Fr.fromString(
      '0x1bef38b621017d3c7416663d0cd81369424560710526a3fbaaec13e356b9d084',
    );
    emptyBlockHeader.state.partial.publicDataTree.nextAvailableLeafIndex = TreeLeafIndex(128);
    const emptyBlock = L2Block.empty(emptyBlockHeader);
    const emptyBlockHash = await emptyBlock.hash();
    expect(emptyBlockHash.equals(GENESIS_BLOCK_HEADER_HASH)).toBeTruthy();
  });

  it.each([2 ** 32, 2 ** 42])('round trips a block whose tree indices are %p', async index => {
    const block = await L2Block.random(BlockNumber(42));
    block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex = TreeLeafIndex(index);
    block.header.state.partial.noteHashTree.nextAvailableLeafIndex = TreeLeafIndex(index);
    block.header.state.partial.nullifierTree.nextAvailableLeafIndex = TreeLeafIndex(index);
    block.header.state.partial.publicDataTree.nextAvailableLeafIndex = TreeLeafIndex(index);

    expect(L2Block.fromBuffer(block.toBuffer())).toEqual(block);
    expect(L2Block.schema.parse(JSON.parse(jsonStringify(block)))).toEqual(block);
    expect(block.toBlockBlobData().blockEndStateField.noteHashNextAvailableLeafIndex).toBe(index);
  });
});
