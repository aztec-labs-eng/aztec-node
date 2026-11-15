import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { DateProvider } from '@aztec-labs/foundation/timer';
import type { L2BlockSource } from '@aztec-labs/stdlib/block';
import { EmptyL1RollupConstants, type L1RollupConstants } from '@aztec-labs/stdlib/epoch-helpers';
import { type MockProxy, mock } from 'jest-mock-extended';

import { EpochProofStatus, type EpochProofStatusDeps } from './epoch-proof-status.js';

describe('EpochProofStatus', () => {
  let l2BlockSource: MockProxy<EpochProofStatusDeps['l2BlockSource'] & L2BlockSource>;
  let rollupContract: MockProxy<Pick<RollupContract, 'getHasSubmittedFullEpochProof'>>;
  let proofStatus: EpochProofStatus;

  // epochDuration=1 ⇒ slot N lives in epoch N.
  const l1Constants = { ...EmptyL1RollupConstants, epochDuration: 1, proofSubmissionEpochs: 1 };

  beforeEach(() => {
    l2BlockSource = mock();
    rollupContract = mock();
    l2BlockSource.getL1Constants.mockResolvedValue(l1Constants);
    proofStatus = new EpochProofStatus({
      l2BlockSource,
      rollupContract,
      proverId: EthAddress.ZERO,
      dateProvider: new DateProvider(),
    });
  });

  describe('isEpochFullyProven', () => {
    /** Asserts on `isEpochFullyProven(epoch)` under the given L1 constants. */
    const expectFullyProven = (epoch: EpochNumber, constants: L1RollupConstants) => {
      l2BlockSource.getL1Constants.mockResolvedValue(constants);
      return expect(proofStatus.isEpochFullyProven(epoch));
    };

    it('returns false when no block is proven yet', async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(undefined);
      await expectFullyProven(EpochNumber(3), l1Constants).resolves.toBe(false);
    });

    it('returns false when the proven block has no header in the archiver', async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockResolvedValue(undefined);
      await expectFullyProven(EpochNumber(3), l1Constants).resolves.toBe(false);
    });

    it("returns true for any epoch strictly below the proven tip's epoch", async () => {
      // Proven block at slot 5 ⇒ provenEpoch = 5 (epochDuration=1).
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockResolvedValue({ header: { getSlot: () => SlotNumber(5) } } as any);
      await expectFullyProven(EpochNumber(3), l1Constants).resolves.toBe(true);
    });

    it("returns false for any epoch strictly above the proven tip's epoch", async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockResolvedValue({ header: { getSlot: () => SlotNumber(5) } } as any);
      await expectFullyProven(EpochNumber(7), l1Constants).resolves.toBe(false);
    });

    it('returns true on the equality case when the proven block is the last of its epoch (next block is in a later epoch)', async () => {
      // provenEpoch=2, next block in epoch 3 ⇒ last of epoch.
      const l1ConstantsTwo = { ...EmptyL1RollupConstants, epochDuration: 2 };
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any); // epoch 2
        }
        if (q.number === 6) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(6) } } as any); // epoch 3
        }
        return Promise.resolve(undefined);
      });
      await expectFullyProven(EpochNumber(2), l1ConstantsTwo).resolves.toBe(true);
    });

    it('returns false on the equality case when the proven block is mid-epoch (next block is in the same epoch)', async () => {
      const l1ConstantsTwo = { ...EmptyL1RollupConstants, epochDuration: 2 };
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(4) } } as any); // epoch 2
        }
        if (q.number === 6) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any); // also epoch 2
        }
        return Promise.resolve(undefined);
      });
      await expectFullyProven(EpochNumber(2), l1ConstantsTwo).resolves.toBe(false);
    });

    it('falls back to isEpochComplete when there is no next-block header', async () => {
      // No next-block header ⇒ the archiver's isEpochComplete decides.
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any);
        }
        return Promise.resolve(undefined); // no next block yet
      });
      l2BlockSource.isEpochComplete.mockResolvedValueOnce(true);
      await expectFullyProven(EpochNumber(5), l1Constants).resolves.toBe(true);

      l2BlockSource.isEpochComplete.mockResolvedValueOnce(false);
      await expectFullyProven(EpochNumber(5), l1Constants).resolves.toBe(false);
    });
  });

  describe('getLastFullyProvenEpoch', () => {
    it('returns no fully-proven epoch when nothing is proven', async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(undefined);
      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(undefined);
    });

    it('returns no fully-proven epoch when the proven block has no archiver header', async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockResolvedValue(undefined);
      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(undefined);
    });

    it('returns provenEpoch when the proven block is the last of its epoch', async () => {
      // epochDuration=1: slot 5 ⇒ epoch 5; next slot 6 ⇒ epoch 6 > 5 ⇒ last of epoch.
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any);
        }
        if (q.number === 6) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(6) } } as any);
        }
        return Promise.resolve(undefined);
      });
      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(EpochNumber(5));
    });

    it('returns provenEpoch via the isEpochComplete fallback when there is no next-block header', async () => {
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any);
        }
        return Promise.resolve(undefined);
      });
      l2BlockSource.isEpochComplete.mockResolvedValue(true);
      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(EpochNumber(5));
    });

    it('returns provenEpoch-1 when proven is mid-epoch', async () => {
      // epochDuration=2: slot 5 ⇒ epoch 2; next slot 5 ⇒ same epoch ⇒ mid-epoch.
      const l1ConstantsTwo = { ...EmptyL1RollupConstants, epochDuration: 2, proofSubmissionEpochs: 1 };
      l2BlockSource.getL1Constants.mockResolvedValue(l1ConstantsTwo);
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(5));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 5) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(4) } } as any); // epoch 2
        }
        if (q.number === 6) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(5) } } as any); // epoch 2
        }
        return Promise.resolve(undefined);
      });

      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(EpochNumber(1));
    });

    it('returns lastFullyProvenEpoch=undefined when proven is mid-epoch within epoch 0', async () => {
      // The provenEpoch=0 edge case: there is no "previous" epoch to claim as fully proven.
      const l1ConstantsTwo = { ...EmptyL1RollupConstants, epochDuration: 2, proofSubmissionEpochs: 1 };
      l2BlockSource.getL1Constants.mockResolvedValue(l1ConstantsTwo);
      l2BlockSource.getBlockNumber.mockResolvedValue(BlockNumber(1));
      l2BlockSource.getBlockData.mockImplementation((q: any) => {
        if (q.number === 1) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(0) } } as any); // epoch 0
        }
        if (q.number === 2) {
          return Promise.resolve({ header: { getSlot: () => SlotNumber(1) } } as any); // still epoch 0
        }
        return Promise.resolve(undefined);
      });

      await expect(proofStatus.getLastFullyProvenEpoch()).resolves.toEqual(undefined);
    });
  });
});
