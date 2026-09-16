import { BLOCK_HEADER_LENGTH } from '@aztec-labs/constants';
import { randomInt } from '@aztec-labs/foundation/crypto/random';
import { setupCustomSnapshotSerializers } from '@aztec-labs/foundation/testing';
import { updateInlineTestData } from '@aztec-labs/foundation/testing/files';

import { makeBlockHeader } from '../tests/factories.js';
import { BlockHeader } from './block_header.js';

describe('BlockHeader', () => {
  let header: BlockHeader;

  beforeAll(() => {
    setupCustomSnapshotSerializers(expect);
    header = makeBlockHeader(randomInt(1000));
  });

  it('serializes to buffer and deserializes it back', () => {
    const buffer = header.toBuffer();
    const res = BlockHeader.fromBuffer(buffer);
    expect(res).toEqual(header);
  });

  it('serializes to field array and deserializes it back', () => {
    const fieldArray = header.toFields();
    const res = BlockHeader.fromFields(fieldArray);
    expect(res).toEqual(header);
  });

  it('computes hash', async () => {
    const seed = 9870243;
    const header = makeBlockHeader(seed);
    const hash = await header.hash();
    expect(hash.toString()).toMatchInlineSnapshot(
      `"0x1e79dab28d2f5be3414dcb6f177bffd2e61f258f85761cceb34eab5dbf205e1e"`,
    );
  });

  it('number of fields matches constant', () => {
    const fields = header.toFields();
    expect(fields.length).toBe(BLOCK_HEADER_LENGTH);
  });

  it('names itself as an anchor carrying both its height and its hash', async () => {
    expect(await header.toBlockParameter()).toEqual({ number: header.getBlockNumber(), hash: await header.hash() });
  });

  it('computes empty hash', async () => {
    const header = BlockHeader.empty();
    const hash = await header.hash();
    expect(hash.toString()).toMatchInlineSnapshot(
      `"0x270629a7878b72709d3600bf6f84458849d70beb86506bbdfa05ba9fe0e130c9"`,
    );

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data
    updateInlineTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/abis/block_header.nr',
      'test_data_empty_hash',
      hash.toString(),
    );
  });
});
