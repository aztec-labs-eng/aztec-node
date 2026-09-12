import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { BlockData } from '@aztec-labs/stdlib/block';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import { type MockProxy, mock } from 'jest-mock-extended';

import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from './cross_chain.js';

describe('isL1ToL2MessageReady', () => {
  let node: MockProxy<Pick<AztecNode, 'getBlockData' | 'getL1ToL2MessageIndex'>>;
  let messageHash: Fr;

  /** A block whose L1-to-L2 message tree holds `leafCount` leaves, i.e. leaf indices 0..leafCount-1. */
  const blockWithMessageLeaves = (leafCount: number) =>
    ({ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: leafCount } } } }) as BlockData;

  beforeEach(() => {
    node = mock();
    messageHash = Fr.random();
  });

  it('returns false when the node has not seen the message yet', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValue(undefined);

    expect(await isL1ToL2MessageReady(node, messageHash)).toBe(false);
    expect(node.getBlockData).not.toHaveBeenCalled();
  });

  // The very first message of a chain has leaf index 0, which is falsy: readiness has to compare it against the leaf
  // count rather than test it for presence, or the first message of every network would read as unseen forever.
  describe('message index zero', () => {
    beforeEach(() => {
      node.getL1ToL2MessageIndex.mockResolvedValue(0n);
    });

    it('is not ready while the tip has consumed nothing', async () => {
      node.getBlockData.mockResolvedValue(blockWithMessageLeaves(0));

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(false);
    });

    it('is ready once the tip holds one leaf', async () => {
      node.getBlockData.mockResolvedValue(blockWithMessageLeaves(1));

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(true);
    });
  });

  describe('latest fallback (no chain tip)', () => {
    beforeEach(() => {
      node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    });

    it('returns true once the latest block has consumed the message leaf', async () => {
      node.getBlockData.mockResolvedValue(blockWithMessageLeaves(6));

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(true);
      expect(node.getBlockData).toHaveBeenCalledWith('latest');
    });

    it('returns false when the latest block stops exactly at the message leaf', async () => {
      node.getBlockData.mockResolvedValue(blockWithMessageLeaves(5));

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(false);
    });

    it('returns false when the latest block is behind the message leaf', async () => {
      node.getBlockData.mockResolvedValue(blockWithMessageLeaves(4));

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(false);
    });

    it('returns false when there is no block', async () => {
      node.getBlockData.mockResolvedValue(undefined);

      expect(await isL1ToL2MessageReady(node, messageHash)).toBe(false);
    });
  });

  describe('with an explicit chain tip', () => {
    beforeEach(() => {
      node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    });

    it('compares against the requested tip instead of latest', async () => {
      // The proven tip lags behind latest: latest consumed the message leaf, proven has not.
      node.getBlockData.mockImplementation(param =>
        Promise.resolve(param === 'proven' ? blockWithMessageLeaves(5) : blockWithMessageLeaves(7)),
      );

      expect(await isL1ToL2MessageReady(node, messageHash, 'latest')).toBe(true);
      expect(await isL1ToL2MessageReady(node, messageHash, 'proven')).toBe(false);
      expect(node.getBlockData).toHaveBeenLastCalledWith('proven');
    });

    it('returns true once the requested tip has consumed the message leaf', async () => {
      node.getBlockData.mockImplementation(param =>
        Promise.resolve(param === 'proven' ? blockWithMessageLeaves(6) : blockWithMessageLeaves(8)),
      );

      expect(await isL1ToL2MessageReady(node, messageHash, 'proven')).toBe(true);
    });
  });
});

describe('waitForL1ToL2MessageReady', () => {
  let node: MockProxy<Pick<AztecNode, 'getBlockData' | 'getL1ToL2MessageIndex'>>;
  let messageHash: Fr;

  const blockWithMessageLeaves = (leafCount: number) =>
    ({ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: leafCount } } } }) as BlockData;

  beforeEach(() => {
    node = mock();
    messageHash = Fr.random();
  });

  // The helper polls, rather than answering once: a caller may start the wait while the message is demonstrably not
  // ready and have it resolve when a later block inserts it.
  it('polls until a later block has consumed the message leaf', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    node.getBlockData
      .mockResolvedValueOnce(blockWithMessageLeaves(3))
      .mockResolvedValueOnce(blockWithMessageLeaves(5))
      .mockResolvedValue(blockWithMessageLeaves(6));

    expect(await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 10 })).toBe(true);
    expect(node.getBlockData).toHaveBeenCalledTimes(3);
  });

  // A message that only reaches the Inbox partway through the wait is the ordinary streaming case: the index is
  // unknown at first and the helper must keep asking rather than settling on the first answer.
  it('polls through a message the node has not indexed yet', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValueOnce(undefined).mockResolvedValue(2n);
    node.getBlockData.mockResolvedValue(blockWithMessageLeaves(3));

    expect(await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 10 })).toBe(true);
  });

  it('forwards the requested chain tip to every poll', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    node.getBlockData.mockImplementation(tag =>
      Promise.resolve(tag === 'proven' ? blockWithMessageLeaves(6) : blockWithMessageLeaves(9)),
    );

    expect(await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 10, chainTip: 'proven' })).toBe(true);
    expect(node.getBlockData.mock.calls.every(([tag]) => tag === 'proven')).toBe(true);
  });

  it('evaluates against latest when no chain tip is given', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    node.getBlockData.mockResolvedValue(blockWithMessageLeaves(6));

    expect(await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 10 })).toBe(true);
    expect(node.getBlockData).toHaveBeenCalledWith('latest');
  });

  // A tip that never reaches the message is a real failure, not a silent false: the caller has to be told.
  it('times out when the requested tip never consumes the message leaf', async () => {
    node.getL1ToL2MessageIndex.mockResolvedValue(5n);
    node.getBlockData.mockResolvedValue(blockWithMessageLeaves(5));

    await expect(waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 1 })).rejects.toThrow(
      `L1 to L2 message ${messageHash.toString()} ready`,
    );
  });
});
