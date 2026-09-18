import { STATE_REFERENCE_LENGTH } from '@aztec-labs/constants';
import { TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { randomInt } from '@aztec-labs/foundation/crypto/random';
import { Fr } from '@aztec-labs/foundation/curves/bn254';

import { makeStateReference } from '../tests/factories.js';
import { AppendOnlyTreeSnapshot } from '../trees/append_only_tree_snapshot.js';
import { PartialStateReference } from './partial_state_reference.js';
import { StateReference } from './state_reference.js';

describe('StateReference', () => {
  let state: StateReference;

  beforeAll(() => {
    state = makeStateReference(randomInt(1000));
  });

  it('serializes to buffer and deserializes it back', () => {
    const buffer = state.toBuffer();
    const res = StateReference.fromBuffer(buffer);
    expect(res).toEqual(state);
  });

  it('serializes to field array and deserializes it back', () => {
    const fieldArray = state.toFields();
    const res = StateReference.fromFields(fieldArray);
    expect(res).toEqual(state);
  });

  it('number of fields matches constant', () => {
    const fields = state.toFields();
    expect(fields.length).toBe(STATE_REFERENCE_LENGTH);
  });

  it.each([2 ** 32, 2 ** 42])('round trips leaf index %p through buffer and fields', index => {
    const withIndex = new StateReference(
      new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
      new PartialStateReference(
        new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
        new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
        new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(index)),
      ),
    );

    expect(StateReference.fromBuffer(withIndex.toBuffer())).toEqual(withIndex);
    expect(StateReference.fromFields(withIndex.toFields())).toEqual(withIndex);
  });
});
