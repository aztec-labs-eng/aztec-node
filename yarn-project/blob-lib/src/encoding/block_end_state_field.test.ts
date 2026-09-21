import {
  L1_TO_L2_MSG_TREE_HEIGHT,
  NOTE_HASH_TREE_HEIGHT,
  NULLIFIER_TREE_HEIGHT,
  PUBLIC_DATA_TREE_HEIGHT,
} from '@aztec-labs/constants';
import { TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { updateInlineFndTestData } from '@aztec-labs/foundation/testing/files';

import {
  TOTAL_MANA_USED_BIT_SIZE,
  decodeBlockEndStateField,
  encodeBlockEndStateField,
} from './block_end_state_field.js';

describe('block end state field', () => {
  it('encode and decode correctly', () => {
    const blockEndStateField = {
      l1ToL2MessageNextAvailableLeafIndex: TreeLeafIndex(4466),
      noteHashNextAvailableLeafIndex: TreeLeafIndex(3377),
      nullifierNextAvailableLeafIndex: TreeLeafIndex(2288),
      publicDataNextAvailableLeafIndex: TreeLeafIndex(1199),
      totalManaUsed: 87654321n,
    };
    const encoded = encodeBlockEndStateField(blockEndStateField);

    const decoded = decodeBlockEndStateField(encoded);
    expect(decoded).toEqual(blockEndStateField);

    // AZTEC_GENERATE_TEST_DATA=1 yarn test block_end_state_field.test.ts
    updateInlineFndTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/block_blob_data.nr',
      'block_end_state_field_from_typescript',
      encoded.toString(),
    );
  });

  it('encode and decode large values correctly', () => {
    const blockEndStateField = {
      l1ToL2MessageNextAvailableLeafIndex: TreeLeafIndex(2 ** L1_TO_L2_MSG_TREE_HEIGHT - 4466),
      noteHashNextAvailableLeafIndex: TreeLeafIndex(2 ** NOTE_HASH_TREE_HEIGHT - 3377),
      nullifierNextAvailableLeafIndex: TreeLeafIndex(2 ** NULLIFIER_TREE_HEIGHT - 2288),
      publicDataNextAvailableLeafIndex: TreeLeafIndex(2 ** PUBLIC_DATA_TREE_HEIGHT - 1199),
      totalManaUsed: 2n ** TOTAL_MANA_USED_BIT_SIZE - 87654321n,
    };
    const encoded = encodeBlockEndStateField(blockEndStateField);

    const decoded = decodeBlockEndStateField(encoded);
    expect(decoded).toEqual(blockEndStateField);

    // AZTEC_GENERATE_TEST_DATA=1 yarn test block_end_state_field.test.ts
    updateInlineFndTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/block_blob_data.nr',
      'large_block_end_state_field_from_typescript',
      encoded.toString(),
    );
  });

  it.each([2 ** 32, 2 ** 42])('encodes and decodes leaf index %p exactly', index => {
    const blockEndStateField = {
      l1ToL2MessageNextAvailableLeafIndex: TreeLeafIndex(Math.min(index, 2 ** L1_TO_L2_MSG_TREE_HEIGHT - 1)),
      noteHashNextAvailableLeafIndex: TreeLeafIndex(Math.min(index, 2 ** NOTE_HASH_TREE_HEIGHT - 1)),
      nullifierNextAvailableLeafIndex: TreeLeafIndex(Math.min(index, 2 ** NULLIFIER_TREE_HEIGHT - 1)),
      publicDataNextAvailableLeafIndex: TreeLeafIndex(Math.min(index, 2 ** PUBLIC_DATA_TREE_HEIGHT - 1)),
      totalManaUsed: 0n,
    };

    expect(decodeBlockEndStateField(encodeBlockEndStateField(blockEndStateField))).toEqual(blockEndStateField);
  });
});
