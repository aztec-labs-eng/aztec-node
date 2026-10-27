import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { SiblingPath } from '@aztec-labs/foundation/trees';
import { type MockProxy, mock } from 'jest-mock-extended';

import { AztecAddress } from '../aztec-address/index.js';
import { randomDataInBlock } from '../block/in_block.js';
import type { AztecNode } from '../interfaces/aztec-node.js';
import { L1ToL2Message, getL1ToL2MessageWitness, lookUpL1ToL2MessageWitness } from './l1_to_l2_message.js';

describe('L1 to L2 message', () => {
  it('can encode an L1 to L2 message to buffer and back', async () => {
    const msg = await L1ToL2Message.random();
    const buffer = msg.toBuffer();
    const recovered = L1ToL2Message.fromBuffer(buffer);
    expect(recovered).toEqual(msg);
  });
});

describe('L1 to L2 message witness lookup', () => {
  let node: MockProxy<AztecNode>;
  let messageHash: Fr;
  let unsiloedNullifier: { contractAddress: AztecAddress; nullifier: Fr };
  let witness: [bigint, SiblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT>];

  beforeEach(async () => {
    node = mock<AztecNode>();
    messageHash = Fr.random();
    unsiloedNullifier = { contractAddress: await AztecAddress.random(), nullifier: Fr.random() };
    witness = [3n, SiblingPath.random(L1_TO_L2_MSG_TREE_HEIGHT)];
    node.findLeavesIndexes.mockResolvedValue([undefined]);
  });

  describe('lookUpL1ToL2MessageWitness', () => {
    it('finds a message that has not been consumed', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);

      expect(await lookUpL1ToL2MessageWitness(node, messageHash, unsiloedNullifier, 'latest')).toEqual({
        type: 'found',
        witness,
      });
    });

    it('reports a message that is not in the tree as missing', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(undefined);

      expect(await lookUpL1ToL2MessageWitness(node, messageHash, undefined, 'latest')).toEqual({ type: 'missing' });
    });

    it('reports a consumed message as nullified when given its nullifier', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);
      node.findLeavesIndexes.mockResolvedValue([randomDataInBlock(7n)]);

      expect(await lookUpL1ToL2MessageWitness(node, messageHash, unsiloedNullifier, 'latest')).toEqual({
        type: 'nullified',
      });
    });

    it('finds a consumed message when no nullifier is given', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);
      node.findLeavesIndexes.mockResolvedValue([randomDataInBlock(7n)]);

      expect(await lookUpL1ToL2MessageWitness(node, messageHash, undefined, 'latest')).toEqual({
        type: 'found',
        witness,
      });
    });
  });

  describe('getL1ToL2MessageWitness', () => {
    it('returns the witness of a message that has not been consumed', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);

      expect(await getL1ToL2MessageWitness(node, messageHash, unsiloedNullifier)).toEqual(witness);
    });

    it('throws for a message that is not in the tree', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(undefined);

      await expect(getL1ToL2MessageWitness(node, messageHash)).rejects.toThrow(
        `No L1 to L2 message found for message hash ${messageHash.toString()}`,
      );
    });

    it('throws for a consumed message when given its nullifier', async () => {
      node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);
      node.findLeavesIndexes.mockResolvedValue([randomDataInBlock(7n)]);

      await expect(getL1ToL2MessageWitness(node, messageHash, unsiloedNullifier)).rejects.toThrow(
        `No non-nullified L1 to L2 message found for message hash ${messageHash.toString()}`,
      );
    });
  });
});
