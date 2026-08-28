import {
  CONTRACT_CLASS_REGISTRY_BYTECODE_CAPSULE_SLOT,
  MAX_PACKED_PUBLIC_BYTECODE_SIZE_IN_FIELDS,
} from '@aztec-labs/constants';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import { type ContractArtifact, bufferAsFields } from '@aztec-labs/stdlib/abi';
import { getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import { Capsule } from '@aztec-labs/stdlib/tx';

import type { ContractFunctionInteraction } from '../contract/contract_function_interaction.js';
import { ContractClassRegistryContract } from '../contract/protocol_contracts/contract-class-registry.js';
import type { Wallet } from '../wallet/index.js';

/** Sets up a call to publish a contract class given its artifact. */
export async function publishContractClass(
  wallet: Wallet,
  artifact: ContractArtifact,
): Promise<ContractFunctionInteraction> {
  const { artifactHash, privateFunctionsRoot, publicBytecodeCommitment, packedBytecode } =
    await getContractClassFromArtifact(artifact);
  const classRegistry = ContractClassRegistryContract.withWallet(wallet);

  const encodedBytecode = bufferAsFields(packedBytecode, MAX_PACKED_PUBLIC_BYTECODE_SIZE_IN_FIELDS);
  return classRegistry.methods.publish(artifactHash, privateFunctionsRoot, publicBytecodeCommitment).with({
    capsules: [
      new Capsule(
        ProtocolContractAddress.ContractClassRegistry,
        new Fr(CONTRACT_CLASS_REGISTRY_BYTECODE_CAPSULE_SLOT),
        encodedBytecode,
      ),
    ],
  });
}
