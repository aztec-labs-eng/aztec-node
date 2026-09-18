import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { updateInlineTestData } from '@aztec-labs/foundation/testing/files';

import { Poseidon2Sponge, SpongeBlob } from './sponge_blob.js';
import { makeSpongeBlob } from './testing.js';

describe('SpongeBlob', () => {
  it('serializes to buffer and deserializes it back', () => {
    const spongeBlob = makeSpongeBlob(1);
    const buffer = spongeBlob.toBuffer();
    const res = SpongeBlob.fromBuffer(buffer);
    expect(res).toEqual(spongeBlob);
  });

  it('serializes to field array and deserializes it back', () => {
    const spongeBlob = makeSpongeBlob(1);
    const fieldArray = spongeBlob.toFields();
    const res = SpongeBlob.fromFields(fieldArray);
    expect(res).toEqual(spongeBlob);
  });

  it('matches a small sponge hash in noir', async () => {
    const spongeBlob = SpongeBlob.init();
    const input = [new Fr(1), new Fr(4), new Fr(7)];
    await spongeBlob.absorb(input);
    const hash = (await spongeBlob.squeeze()).toString();

    expect(hash).toMatchInlineSnapshot('"0x142a2d54d67841d1ab00580036a6bb63e7ff8c1bc4ca5232628a9dde48bd55ae"');

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data.
    updateInlineTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/sponge_blob.nr',
      'small_sponge_hash_from_ts',
      hash,
    );
  });

  it('matches a full sponge hash in noir', async () => {
    const spongeBlob = SpongeBlob.init();
    const fields = Array.from({ length: SpongeBlob.MAX_FIELDS }).map((_, i) => new Fr(i + 123));
    await spongeBlob.absorb(fields);
    const hash = (await spongeBlob.squeeze()).toString();

    expect(hash).toMatchInlineSnapshot('"0x23f78d3bf4a9e4a96e28d05f4daaa32a91c93dac6e9903246dc69c2290e7a000"');

    // Run with AZTEC_GENERATE_TEST_DATA=1 to update noir test data.
    updateInlineTestData(
      'noir-projects/fnd/noir-protocol-circuits/crates/types/src/blob_data/sponge_blob.nr',
      'full_sponge_hash_from_ts',
      hash,
    );
  });
});

describe('Poseidon2Sponge', () => {
  /** Absorbs one field at a time, mirroring noir's Poseidon2Sponge::absorb, whose whole struct circuits compare. */
  const absorbPerField = async (sponge: Poseidon2Sponge, fields: Fr[]) => {
    for (const field of fields) {
      if (sponge.cacheSize === sponge.cache.length) {
        await sponge.performDuplex();
        sponge.cache[0] = field;
        sponge.cacheSize = 1;
      } else {
        sponge.cache[sponge.cacheSize++] = field;
      }
    }
  };

  it.each([
    { lengths: [5] },
    { lengths: [4] },
    { lengths: [7] },
    { lengths: [3, 1] },
    { lengths: [3, 2] },
    { lengths: [3, 5] },
    { lengths: [2, 2] },
    { lengths: [1, 1, 1, 1, 1] },
    { lengths: [1, 4, 6] },
    { lengths: [0, 3, 0, 4] },
    { lengths: [10, 11, 3, 7] },
  ])(
    'matches a field-by-field absorb, unused cache slots included, for absorb lengths $lengths',
    async ({ lengths }) => {
      const chunked = Poseidon2Sponge.init(new Fr(42));
      const perField = Poseidon2Sponge.init(new Fr(42));
      let next = 1;
      for (const length of lengths) {
        const fields = Array.from({ length }, () => new Fr(next++));
        await chunked.absorb(fields);
        await absorbPerField(perField, fields);
        expect(chunked.toFields()).toEqual(perField.toFields());
      }
      expect(await chunked.squeeze()).toEqual(await perField.squeeze());
    },
  );
});
