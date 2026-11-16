import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';

import PostQuantumPublicKeyRegistryJson from '../../artifacts/PostQuantumPublicKeyRegistry.json' with { type: 'json' };
import { makeStandardContract } from '../make_standard_contract.js';
import type { StandardContract } from '../standard_contract.js';

export {
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS,
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_CLASS_ID,
  STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_SALT,
} from './constants.js';

export const PostQuantumPublicKeyRegistryArtifact = loadContractArtifact(
  PostQuantumPublicKeyRegistryJson as NoirCompiledContract,
);

let standardContract: StandardContract;

/** Returns the standard deployment of the post-quantum public key registry. */
export function getStandardPostQuantumPublicKeyRegistry(): Promise<StandardContract> {
  if (!standardContract) {
    standardContract = makeStandardContract('PostQuantumPublicKeyRegistry', PostQuantumPublicKeyRegistryArtifact);
  }
  return Promise.resolve(standardContract);
}
