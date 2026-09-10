import { SpongeBlob } from '@aztec-labs/blob-lib';
import {
  ARCHIVE_HEIGHT,
  L1_TO_L2_MSG_TREE_HEIGHT,
  NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH,
} from '@aztec-labs/constants';
import { makeTuple } from '@aztec-labs/foundation/array';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { makePublicInputsAndRecursiveProof } from '@aztec-labs/stdlib/interfaces/server';
import { L1ToL2MessageSponge } from '@aztec-labs/stdlib/messaging';
import { makeRecursiveProof } from '@aztec-labs/stdlib/proofs';
import { CheckpointConstantData, TxRollupPublicInputs } from '@aztec-labs/stdlib/rollup';
import { makeBlockRollupPublicInputs } from '@aztec-labs/stdlib/testing';
import { AppendOnlyTreeSnapshot } from '@aztec-labs/stdlib/trees';
import { StateReference, txEffectsTreeNodeHash } from '@aztec-labs/stdlib/tx';
import { VerificationKeyData } from '@aztec-labs/stdlib/vks';
import { mock } from 'jest-mock-extended';

import { BlockProvingState } from './block-proving-state.js';
import type { CheckpointProvingState } from './checkpoint-proving-state.js';

describe('BlockProvingState.buildHeaderFromProvingOutputs', () => {
  it('requires the block root proof', async () => {
    const state = makeState(0, false);

    await expect(state.buildHeaderFromProvingOutputs()).rejects.toThrow('Block root rollup is not ready');
  });

  it('uses zero for a block with no transactions', async () => {
    const header = await makeState(0).buildHeaderFromProvingOutputs();

    expect(header.txEffectsTreeRoot).toEqual(Fr.ZERO);
  });

  it('uses the single base proof root without requiring local transaction effects', async () => {
    const state = makeState(1);
    state.setBaseRollupProof(0, makeTxProof(new Fr(123)));

    const header = await state.buildHeaderFromProvingOutputs();

    expect(header.txEffectsTreeRoot).toEqual(new Fr(123));
  });

  it.each([1, 2, 3])('rejects missing transaction proofs for a %i-tx block', async numTxs => {
    const state = makeState(numTxs);
    if (numTxs > 1) {
      state.setBaseRollupProof(0, makeTxProof(new Fr(123)));
    }

    await expect(state.buildHeaderFromProvingOutputs()).rejects.toThrow(
      'At least one child is not ready for the block root rollup',
    );
  });

  it('combines the two base proof roots for a two-tx block', async () => {
    const state = makeState(2);
    const left = new Fr(123);
    const right = new Fr(456);
    state.setBaseRollupProof(0, makeTxProof(left));
    state.setBaseRollupProof(1, makeTxProof(right));

    const header = await state.buildHeaderFromProvingOutputs();

    expect(header.txEffectsTreeRoot).toEqual(
      Fr.fromBuffer(await txEffectsTreeNodeHash(left.toBuffer(), right.toBuffer())),
    );
  });

  it('combines a merge proof root and a base proof root for a three-tx block', async () => {
    const state = makeState(3);
    const left = new Fr(123);
    const right = new Fr(456);
    state.setBaseRollupProof(0, makeTxProof(new Fr(10)));
    state.setBaseRollupProof(1, makeTxProof(new Fr(20)));
    state.setBaseRollupProof(2, makeTxProof(right));
    state.setMergeRollupProof({ level: 1, index: 0 }, makeTxProof(left));

    const header = await state.buildHeaderFromProvingOutputs();

    expect(header.txEffectsTreeRoot).toEqual(
      Fr.fromBuffer(await txEffectsTreeNodeHash(left.toBuffer(), right.toBuffer())),
    );
  });

  it('combines both merge proof roots for a four-tx block', async () => {
    const state = makeState(4);
    const left = new Fr(123);
    const right = new Fr(456);
    state.setMergeRollupProof({ level: 1, index: 0 }, makeTxProof(left));
    state.setMergeRollupProof({ level: 1, index: 1 }, makeTxProof(right));

    const header = await state.buildHeaderFromProvingOutputs();

    expect(header.txEffectsTreeRoot).toEqual(
      Fr.fromBuffer(await txEffectsTreeNodeHash(left.toBuffer(), right.toBuffer())),
    );
  });
});

function makeTxProof(root: Fr) {
  const inputs = TxRollupPublicInputs.empty();
  inputs.accumulatedTxEffectsTreeRoot = root;
  return makeProof(inputs);
}

function makeProof<T>(inputs: T) {
  return makePublicInputsAndRecursiveProof(
    inputs,
    makeRecursiveProof(NESTED_RECURSIVE_ROLLUP_HONK_PROOF_LENGTH),
    VerificationKeyData.makeFakeHonk(),
  );
}

function makeState(numTxs: number, withBlockRootProof = true) {
  const state = new BlockProvingState(
    0,
    BlockNumber(1),
    numTxs,
    CheckpointConstantData.empty(),
    0n,
    AppendOnlyTreeSnapshot.empty(),
    makeTuple(ARCHIVE_HEIGHT, () => Fr.ZERO),
    StateReference.empty(),
    AppendOnlyTreeSnapshot.empty(),
    AppendOnlyTreeSnapshot.empty(),
    makeTuple(L1_TO_L2_MSG_TREE_HEIGHT, () => Fr.ZERO),
    [],
    L1ToL2MessageSponge.empty(),
    L1ToL2MessageSponge.empty(),
    SpongeBlob.init(),
    mock<CheckpointProvingState>(),
  );
  if (withBlockRootProof) {
    const inputs = makeBlockRollupPublicInputs();
    inputs.endSpongeBlob = SpongeBlob.init();
    state.setBlockRootRollupProof(makeProof(inputs));
  }
  return state;
}
