import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { jsonParseWithSchema, jsonStringify } from '@aztec-labs/foundation/json-rpc';
import { SiblingPath } from '@aztec-labs/foundation/trees';

import { Body } from '../block/body.js';
import {
  TxEffectMembershipWitnessSchema,
  computeRootFromTxEffectMembershipWitness,
  computeTxEffectMembershipWitness,
  verifyTxEffectMembershipWitness,
} from './tx_effect_membership.js';

describe('TxEffectMembershipWitness', () => {
  const makeBody = (txsPerBlock: number) => Body.random({ txsPerBlock, maxEffects: 1, numPublicCallsPerTx: 1 });

  it('round trips through the schema', () => {
    const witness = {
      blockNumber: BlockNumber(7),
      root: Fr.random(),
      leafIndex: 3n,
      siblingPath: new SiblingPath(2, [Fr.random().toBuffer(), Fr.random().toBuffer()]),
    };
    expect(jsonParseWithSchema(jsonStringify(witness), TxEffectMembershipWitnessSchema)).toEqual(witness);
  });

  it('builds witnesses against the same root the block body commits to', async () => {
    const body = await makeBody(5);
    const root = await body.computeTxEffectsTreeRoot();

    for (let txIndex = 0; txIndex < body.txEffects.length; txIndex++) {
      const witness = await computeTxEffectMembershipWitness(body.txEffects, txIndex);
      expect(witness.root).toEqual(root);
    }
  });

  it('builds an empty witness for a single-tx block', async () => {
    const body = await makeBody(1);
    const witness = await computeTxEffectMembershipWitness(body.txEffects, 0);

    expect(witness.siblingPath.pathSize).toBe(0);
    expect(witness.leafIndex).toBe(0n);
    expect(witness.root).toEqual(await body.txEffects[0].computeTxEffectsTreeLeaf());
  });

  it('verifies witnesses for every tx of a block and rejects tampered ones', async () => {
    const body = await makeBody(3);
    const root = await body.computeTxEffectsTreeRoot();

    for (let txIndex = 0; txIndex < body.txEffects.length; txIndex++) {
      const leaf = await body.txEffects[txIndex].computeTxEffectsTreeLeaf();
      const witness = await computeTxEffectMembershipWitness(body.txEffects, txIndex);

      expect(await computeRootFromTxEffectMembershipWitness(leaf, witness)).toEqual(root);
      expect(await verifyTxEffectMembershipWitness(leaf, witness, root)).toBe(true);

      expect(await verifyTxEffectMembershipWitness(leaf, witness, Fr.random())).toBe(false);
      expect(await verifyTxEffectMembershipWitness(leaf, { ...witness, leafIndex: witness.leafIndex ^ 1n }, root)).toBe(
        false,
      );
      const tamperedPath = new SiblingPath(witness.siblingPath.pathSize, [
        Fr.random().toBuffer(),
        ...witness.siblingPath.toBufferArray().slice(1),
      ]);
      expect(await verifyTxEffectMembershipWitness(leaf, { ...witness, siblingPath: tamperedPath }, root)).toBe(false);
    }
  });

  it('verifies the single-tx witness where the leaf is the root', async () => {
    const body = await makeBody(1);
    const leaf = await body.txEffects[0].computeTxEffectsTreeLeaf();
    const witness = await computeTxEffectMembershipWitness(body.txEffects, 0);

    expect(await computeRootFromTxEffectMembershipWitness(leaf, witness)).toEqual(leaf);
    expect(await verifyTxEffectMembershipWitness(leaf, witness, await body.computeTxEffectsTreeRoot())).toBe(true);
    expect(await verifyTxEffectMembershipWitness(Fr.random(), witness, witness.root)).toBe(false);
  });

  it('throws for a tx index outside the block', async () => {
    const body = await makeBody(2);
    await expect(computeTxEffectMembershipWitness(body.txEffects, 2)).rejects.toThrow('out of bounds');
  });
});
