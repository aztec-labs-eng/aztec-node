import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type ContractInstanceWithAddress, SerializableContractInstance } from '@aztec-labs/stdlib/contract';
import '@aztec-labs/stdlib/testing/jest';

import { ContractInstanceStore } from './contract_instance_store.js';

describe('ContractInstanceStore', () => {
  let contractInstanceStore: ContractInstanceStore;

  beforeEach(async () => {
    contractInstanceStore = new ContractInstanceStore(await openTmpStore('contract_instance_store_test'));
  });

  describe('contractInstances', () => {
    let contractInstance: ContractInstanceWithAddress;
    const blockNum = 10;
    const timestamp = 3600n;

    beforeEach(async () => {
      const classId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: classId,
        originalContractClassId: classId,
      });
      contractInstance = { ...randomInstance, address: await AztecAddress.random() };
      await contractInstanceStore.addContractInstances([contractInstance], BlockNumber(blockNum));
    });

    it('returns previously stored contract instances', async () => {
      await expect(
        contractInstanceStore.getContractInstance(contractInstance.address, timestamp),
      ).resolves.toMatchObject(contractInstance);
    });

    it('returns undefined if contract instance is not found', async () => {
      await expect(
        contractInstanceStore.getContractInstance(await AztecAddress.random(), timestamp),
      ).resolves.toBeUndefined();
    });

    it('returns undefined if previously stored contract instances was deleted', async () => {
      await contractInstanceStore.deleteContractInstances([contractInstance], BlockNumber(blockNum));
      await expect(
        contractInstanceStore.getContractInstance(contractInstance.address, timestamp),
      ).resolves.toBeUndefined();
    });

    it('does not delete an instance published by a different block', async () => {
      await contractInstanceStore.deleteContractInstances([contractInstance], BlockNumber(blockNum + 1));
      await expect(
        contractInstanceStore.getContractInstance(contractInstance.address, timestamp),
      ).resolves.toMatchObject(contractInstance);
      await expect(
        contractInstanceStore.getContractInstanceDeploymentBlockNumber(contractInstance.address),
      ).resolves.toEqual(blockNum);
    });

    it('reports success for batch adds and deletes', async () => {
      const other = { ...(await SerializableContractInstance.random()), address: await AztecAddress.random() };
      await expect(contractInstanceStore.addContractInstances([other], BlockNumber(blockNum))).resolves.toBe(true);
      await expect(
        contractInstanceStore.deleteContractInstances([contractInstance, other], BlockNumber(blockNum)),
      ).resolves.toBe(true);
    });

    it('throws when adding the same contract instance again at a different block', async () => {
      await expect(contractInstanceStore.addContractInstances([contractInstance], BlockNumber(2))).rejects.toThrow(
        /already exists/,
      );
    });

    it('treats re-adding the same contract instance at the same block as a no-op (A-1350)', async () => {
      // An L1 reorg can re-present an already-stored checkpoint, replaying this instance at the same block.
      await expect(
        contractInstanceStore.addContractInstances([contractInstance], BlockNumber(blockNum)),
      ).resolves.not.toThrow();
      await expect(
        contractInstanceStore.getContractInstance(contractInstance.address, timestamp),
      ).resolves.toMatchObject(contractInstance);
      await expect(
        contractInstanceStore.getContractInstanceDeploymentBlockNumber(contractInstance.address),
      ).resolves.toEqual(blockNum);
    });
  });

  describe('protocol contract instances (A-1257)', () => {
    // Protocol contracts are preloaded at synthetic block 0. A later on-chain (re-)publish of a
    // bundled protocol instance must be treated as a no-op rather than a hard error, and must never
    // delete the preloaded entry.
    let protocolInstance: ContractInstanceWithAddress;
    const timestamp = 3600n;
    const preloadBlock = 0;

    beforeEach(async () => {
      const classId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: classId,
        originalContractClassId: classId,
      });
      protocolInstance = { ...randomInstance, address: ProtocolContractAddress.ContractClassRegistry };
      await contractInstanceStore.addContractInstances([protocolInstance], BlockNumber(preloadBlock));
    });

    it('treats re-publish of a preloaded protocol instance as a no-op and keeps it queryable', async () => {
      await expect(
        contractInstanceStore.addContractInstances([protocolInstance], BlockNumber(50)),
      ).resolves.not.toThrow();
      await expect(
        contractInstanceStore.getContractInstance(protocolInstance.address, timestamp),
      ).resolves.toMatchObject(protocolInstance);
      // The block-0 preload must be left untouched: the re-publish must not bump the recorded deployment block.
      await expect(
        contractInstanceStore.getContractInstanceDeploymentBlockNumber(protocolInstance.address),
      ).resolves.toEqual(preloadBlock);
    });

    it('does not delete a protocol instance', async () => {
      await contractInstanceStore.deleteContractInstances([protocolInstance], BlockNumber(preloadBlock));
      await expect(
        contractInstanceStore.getContractInstance(protocolInstance.address, timestamp),
      ).resolves.toMatchObject(protocolInstance);
    });

    it('still throws when a non-protocol instance is added twice', async () => {
      const classId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: classId,
        originalContractClassId: classId,
      });
      const nonProtocolInstance = { ...randomInstance, address: await AztecAddress.random() };
      await contractInstanceStore.addContractInstances([nonProtocolInstance], BlockNumber(10));
      await expect(contractInstanceStore.addContractInstances([nonProtocolInstance], BlockNumber(11))).rejects.toThrow(
        /already exists/,
      );
    });
  });

  describe('contractInstanceUpdates', () => {
    let contractInstance: ContractInstanceWithAddress;
    let classId: Fr;
    let nextClassId: Fr;
    const timestampOfChange = 3600n;

    beforeEach(async () => {
      classId = Fr.random();
      nextClassId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: classId,
        originalContractClassId: classId,
      });
      contractInstance = { ...randomInstance, address: await AztecAddress.random() };
      await contractInstanceStore.addContractInstances([contractInstance], BlockNumber(1));
      await contractInstanceStore.addContractInstanceUpdates(
        [
          {
            prevContractClassId: classId,
            newContractClassId: nextClassId,
            timestampOfChange,
            address: contractInstance.address,
          },
        ],
        timestampOfChange - 1n,
        BlockNumber(2),
      );
    });

    it('gets the correct current class id for a contract not updated yet', async () => {
      const fetchedInstance = await contractInstanceStore.getContractInstance(
        contractInstance.address,
        timestampOfChange - 1n,
      );
      expect(fetchedInstance?.originalContractClassId).toEqual(classId);
      expect(fetchedInstance?.currentContractClassId).toEqual(classId);
    });

    it('gets the correct current class id for a contract that has just been updated', async () => {
      const fetchedInstance = await contractInstanceStore.getContractInstance(
        contractInstance.address,
        timestampOfChange,
      );
      expect(fetchedInstance?.originalContractClassId).toEqual(classId);
      expect(fetchedInstance?.currentContractClassId).toEqual(nextClassId);
    });

    it('gets the correct current class id for a contract that was updated in the past', async () => {
      const fetchedInstance = await contractInstanceStore.getContractInstance(
        contractInstance.address,
        timestampOfChange + 1n,
      );
      expect(fetchedInstance?.originalContractClassId).toEqual(classId);
      expect(fetchedInstance?.currentContractClassId).toEqual(nextClassId);
    });

    it('ignores updates for the wrong contract', async () => {
      const otherClassId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: otherClassId,
        originalContractClassId: otherClassId,
      });
      const otherContractInstance = {
        ...randomInstance,
        address: await AztecAddress.random(),
      };
      await contractInstanceStore.addContractInstances([otherContractInstance], BlockNumber(1));

      const fetchedInstance = await contractInstanceStore.getContractInstance(
        otherContractInstance.address,
        timestampOfChange + 1n,
      );
      expect(fetchedInstance?.originalContractClassId).toEqual(otherClassId);
      expect(fetchedInstance?.currentContractClassId).toEqual(otherClassId);
    });

    it('bounds its search to the right contract if more than than one update exists', async () => {
      const otherClassId = Fr.random();
      const otherNextClassId = Fr.random();
      const randomInstance = await SerializableContractInstance.random({
        currentContractClassId: otherClassId,
        originalContractClassId: otherNextClassId,
      });
      const otherContractInstance = {
        ...randomInstance,
        address: await AztecAddress.random(),
      };
      await contractInstanceStore.addContractInstances([otherContractInstance], BlockNumber(1));
      await contractInstanceStore.addContractInstanceUpdates(
        [
          {
            prevContractClassId: otherClassId,
            newContractClassId: otherNextClassId,
            timestampOfChange,
            address: otherContractInstance.address,
          },
        ],
        timestampOfChange - 1n,
        BlockNumber(2),
      );

      const fetchedInstance = await contractInstanceStore.getContractInstance(
        contractInstance.address,
        timestampOfChange + 1n,
      );
      expect(fetchedInstance?.originalContractClassId).toEqual(classId);
      expect(fetchedInstance?.currentContractClassId).toEqual(nextClassId);
    });
  });
  describe('contractInstanceUpdates ordering', () => {
    let address: AztecAddress;
    let originalClassId: Fr;

    /** Schedules a class change for `address` in the given block at the given scheduling timestamp. */
    function addUpdate(
      newContractClassId: Fr,
      opts: {
        schedulingTimestamp: bigint;
        blockNumber: number;
        timestampOfChange?: bigint;
        prevContractClassId?: Fr;
        address?: AztecAddress;
      },
    ) {
      return contractInstanceStore.addContractInstanceUpdates(
        [
          {
            prevContractClassId: opts.prevContractClassId ?? originalClassId,
            newContractClassId,
            timestampOfChange: opts.timestampOfChange ?? opts.schedulingTimestamp,
            address: opts.address ?? address,
          },
        ],
        opts.schedulingTimestamp,
        BlockNumber(opts.blockNumber),
      );
    }

    beforeEach(async () => {
      address = await AztecAddress.random();
      originalClassId = Fr.random();
    });

    it('resolves the higher block number when two blocks share a scheduling timestamp', async () => {
      const first = Fr.random();
      const second = Fr.random();
      await addUpdate(first, { schedulingTimestamp: 1000n, blockNumber: 5 });
      await addUpdate(second, { schedulingTimestamp: 1000n, blockNumber: 6 });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1001n, originalClassId),
      ).resolves.toEqual(second);
    });

    it('resolves the higher index when a single block carries several updates', async () => {
      const first = Fr.random();
      const second = Fr.random();
      await contractInstanceStore.addContractInstanceUpdates(
        [
          { prevContractClassId: originalClassId, newContractClassId: first, timestampOfChange: 1000n, address },
          { prevContractClassId: first, newContractClassId: second, timestampOfChange: 1000n, address },
        ],
        1000n,
        BlockNumber(5),
      );

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1001n, originalClassId),
      ).resolves.toEqual(second);
    });

    it('reveals the earlier block update when the later same-timestamp block is deleted', async () => {
      const first = Fr.random();
      const second = Fr.random();
      await addUpdate(first, { schedulingTimestamp: 1000n, blockNumber: 5 });
      await expect(addUpdate(second, { schedulingTimestamp: 1000n, blockNumber: 6 })).resolves.toBe(true);

      await expect(
        contractInstanceStore.deleteContractInstanceUpdates(
          [{ prevContractClassId: originalClassId, newContractClassId: second, timestampOfChange: 1000n, address }],
          1000n,
          BlockNumber(6),
        ),
      ).resolves.toBe(true);

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1001n, originalClassId),
      ).resolves.toEqual(first);
    });

    it('keeps updates for different addresses isolated', async () => {
      const otherAddress = await AztecAddress.random();
      const mine = Fr.random();
      const theirs = Fr.random();
      await addUpdate(mine, { schedulingTimestamp: 1000n, blockNumber: 5 });
      await addUpdate(theirs, { schedulingTimestamp: 1000n, blockNumber: 6, address: otherAddress });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1001n, originalClassId),
      ).resolves.toEqual(mine);
      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(otherAddress, 1001n, originalClassId),
      ).resolves.toEqual(theirs);
    });

    it('resolves the later timestamp even when it sits in a lower block number', async () => {
      const earlier = Fr.random();
      const later = Fr.random();
      await addUpdate(earlier, { schedulingTimestamp: 1000n, blockNumber: 9 });
      await addUpdate(later, { schedulingTimestamp: 2000n, blockNumber: 3 });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 2001n, originalClassId),
      ).resolves.toEqual(later);
    });

    it('finds an update whose timestamp has fewer digits than the queried one', async () => {
      const newClassId = Fr.random();
      await addUpdate(newClassId, { schedulingTimestamp: 99n, blockNumber: 1 });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 100n, originalClassId),
      ).resolves.toEqual(newClassId);
    });

    it('orders timestamps numerically across a decimal digit boundary', async () => {
      const atNinetyNine = Fr.random();
      const atOneHundred = Fr.random();
      await addUpdate(atNinetyNine, { schedulingTimestamp: 99n, blockNumber: 1 });
      await addUpdate(atOneHundred, { schedulingTimestamp: 100n, blockNumber: 2 });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1000n, originalClassId),
      ).resolves.toEqual(atOneHundred);
    });

    it('returns the previous class id before activation and the new one at activation', async () => {
      const newClassId = Fr.random();
      await addUpdate(newClassId, { schedulingTimestamp: 1000n, blockNumber: 5, timestampOfChange: 2000n });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 1999n, originalClassId),
      ).resolves.toEqual(originalClassId);
      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, 2000n, originalClassId),
      ).resolves.toEqual(newClassId);
    });

    it('builds a valid upper boundary when querying at the maximum uint64 timestamp', async () => {
      const newClassId = Fr.random();
      const maxUint64 = 2n ** 64n - 1n;
      await addUpdate(newClassId, { schedulingTimestamp: maxUint64, blockNumber: 5 });

      await expect(
        contractInstanceStore.getCurrentContractInstanceClassId(address, maxUint64, originalClassId),
      ).resolves.toEqual(newClassId);
    });
  });
});
