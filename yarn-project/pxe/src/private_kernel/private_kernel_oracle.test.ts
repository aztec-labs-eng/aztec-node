import { PUBLIC_DATA_TREE_HEIGHT } from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { SiblingPath } from '@aztec-labs/foundation/trees';
import type { KeyStore } from '@aztec-labs/key-store';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { DelayedPublicMutableValuesWithHash } from '@aztec-labs/stdlib/delayed-public-mutable';
import { computePublicDataTreeLeafSlot } from '@aztec-labs/stdlib/hash';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';
import { PublicDataTreeLeaf, PublicDataTreeLeafPreimage, PublicDataWitness } from '@aztec-labs/stdlib/trees';
import { BlockHeader } from '@aztec-labs/stdlib/tx';
import { mock } from 'jest-mock-extended';

import type { ContractClassService } from '../contract/contract_class_service.js';
import type { ContractStore } from '../storage/contract_store/contract_store.js';
import { PrivateKernelOracle } from './private_kernel_oracle.js';

describe('PrivateKernelOracle', () => {
  let oracle: PrivateKernelOracle;
  let node: ReturnType<typeof mock<AztecNode>>;

  beforeEach(() => {
    node = mock<AztecNode>();
    oracle = new PrivateKernelOracle(
      mock<ContractStore>(),
      mock<ContractClassService>(),
      mock<KeyStore>(),
      node,
      BlockHeader.empty(),
    );
  });

  describe('getUpdatedClassIdHints', () => {
    it('skips storage reads when contract class was never updated', async () => {
      const contractAddress = await AztecAddress.random();
      const hashLeafSlot = await getHashLeafSlot(contractAddress);

      // Non-matching slot simulates a low-leaf witness (slot was never written)
      const unrelatedSlot = new Fr(hashLeafSlot.toBigInt() - 1n);
      node.getPublicDataWitness.mockResolvedValue(makeWitness(unrelatedSlot));

      const result = await oracle.getUpdatedClassIdHints(contractAddress);

      expect(result.updatedClassIdValues.isEmpty()).toBe(true);
      expect(node.getPublicStorageAt).not.toHaveBeenCalled();
    });

    it('reads storage when contract class was updated', async () => {
      const contractAddress = await AztecAddress.random();
      const hashLeafSlot = await getHashLeafSlot(contractAddress);

      // Matching slot means the contract class was updated
      node.getPublicDataWitness.mockResolvedValue(makeWitness(hashLeafSlot, Fr.random()));
      node.getPublicStorageAt.mockResolvedValue(new Fr(42));

      const result = await oracle.getUpdatedClassIdHints(contractAddress);

      expect(result.updatedClassIdValues.isEmpty()).toBe(false);
      expect(node.getPublicStorageAt).toHaveBeenCalled();
    });
  });

  async function getHashLeafSlot(contractAddress: AztecAddress) {
    const { delayedPublicMutableHashSlot } =
      await DelayedPublicMutableValuesWithHash.getContractUpdateSlots(contractAddress);
    return computePublicDataTreeLeafSlot(
      ProtocolContractAddress.ContractInstanceRegistry,
      delayedPublicMutableHashSlot,
    );
  }

  function makeWitness(slot: Fr, value: Fr = Fr.ZERO) {
    return new PublicDataWitness(
      0n,
      new PublicDataTreeLeafPreimage(new PublicDataTreeLeaf(slot, value), Fr.ZERO, 0n),
      SiblingPath.random(PUBLIC_DATA_TREE_HEIGHT),
    );
  }
});
