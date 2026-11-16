import { type ContractArtifact, loadContractArtifact } from '@aztec-labs/stdlib/abi';

import { makeStandardContract } from '../make_standard_contract.js';
import type { StandardContract } from '../standard_contract.js';

export {
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS,
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_CLASS_ID,
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_SALT,
} from './constants.js';

let standardContract: StandardContract;
let standardContractArtifact: ContractArtifact;

export async function getPostQuantumPublicKeyRegistryArtifact(): Promise<ContractArtifact> {
  if (!standardContractArtifact) {
    // Cannot assert this import as it's incompatible with bundlers like vite
    // https://github.com/vitejs/vite/issues/19095#issuecomment-2566074352
    // Even if now supported by all major browsers, the MIME type is replaced with
    // "text/javascript"
    // In the meantime, this lazy import is INCOMPATIBLE WITH NODEJS
    const { default: postQuantumPublicKeyRegistryJson } = await import(
      '../../artifacts/PostQuantumPublicKeyRegistry.json'
    );
    standardContractArtifact = loadContractArtifact(postQuantumPublicKeyRegistryJson);
  }
  return standardContractArtifact;
}

/** Returns the standard deployment of the post-quantum public key registry. */
export async function getStandardPostQuantumPublicKeyRegistry(): Promise<StandardContract> {
  if (!standardContract) {
    const artifact = await getPostQuantumPublicKeyRegistryArtifact();
    standardContract = makeStandardContract('PostQuantumPublicKeyRegistry', artifact);
  }
  return standardContract;
}
