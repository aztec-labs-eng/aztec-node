import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { L1_TO_L2_MSG_TREE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { SiblingPath } from '@aztec-labs/foundation/trees';
import { randomDataInBlock } from '@aztec-labs/stdlib/block';
import { type MockProxy, mock } from 'jest-mock-extended';

import { waitForFeeJuiceClaimMessage } from './bridge_fee_juice.js';

describe('waitForFeeJuiceClaimMessage', () => {
  const intervalMs = 10;
  const log = () => {};

  let node: MockProxy<AztecNode>;
  let messageHash: Fr;
  let claimSecret: Fr;
  let witness: [bigint, SiblingPath<typeof L1_TO_L2_MSG_TREE_HEIGHT>];

  beforeEach(() => {
    node = mock<AztecNode>();
    messageHash = Fr.random();
    claimSecret = Fr.random();
    witness = [5n, SiblingPath.random(L1_TO_L2_MSG_TREE_HEIGHT)];
    node.findLeavesIndexes.mockResolvedValue([undefined]);
  });

  it('keeps polling while the node has not indexed the message yet', async () => {
    node.getL1ToL2MessageMembershipWitness
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(witness);

    await expect(waitForFeeJuiceClaimMessage(node, messageHash, claimSecret, intervalMs, log)).resolves.toEqual(
      witness,
    );
  });

  it('fails instead of polling forever when the message has already been claimed', async () => {
    node.getL1ToL2MessageMembershipWitness.mockResolvedValue(witness);
    node.findLeavesIndexes.mockResolvedValue([randomDataInBlock(7n)]);

    await expect(waitForFeeJuiceClaimMessage(node, messageHash, claimSecret, intervalMs, log)).rejects.toThrow(
      /already been consumed/,
    );
  });

  it('surfaces node errors', async () => {
    node.getL1ToL2MessageMembershipWitness.mockRejectedValue(new Error('node unreachable'));

    await expect(waitForFeeJuiceClaimMessage(node, messageHash, claimSecret, intervalMs, log)).rejects.toThrow(
      'node unreachable',
    );
  });
});
