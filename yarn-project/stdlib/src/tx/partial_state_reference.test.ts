import { PARTIAL_STATE_REFERENCE_LENGTH } from '@aztec-labs/constants';
import { TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { randomInt } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { makePartialStateReference } from '../tests/factories.js';
import { AppendOnlyTreeSnapshot } from '../trees/append_only_tree_snapshot.js';
import { PartialStateReference } from './partial_state_reference.js';

describe('PartialStateReference', () => {
  let partial: PartialStateReference;

  beforeAll(() => {
    partial = makePartialStateReference(randomInt(1000));
  });

  it('serializes to buffer and deserializes it back', () => {
    const buffer = partial.toBuffer();
    const res = PartialStateReference.fromBuffer(buffer);
    expect(res).toEqual(partial);
  });

  it('serializes to field array and deserializes it back', () => {
    const fieldArray = partial.toFields();
    const res = PartialStateReference.fromFields(fieldArray);
    expect(res).toEqual(partial);
  });

  it('number of fields matches constant', () => {
    const fields = partial.toFields();
    expect(fields.length).toBe(PARTIAL_STATE_REFERENCE_LENGTH);
  });

  it.each([2 ** 32, 2 ** 42])('round trips leaf index %p through buffer and fields', index => {
    const withIndex = new PartialStateReference(
      new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
      new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
      new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
    );

    expect(PartialStateReference.fromBuffer(withIndex.toBuffer())).toEqual(withIndex);
    expect(PartialStateReference.fromFields(withIndex.toFields())).toEqual(withIndex);
  });
});
