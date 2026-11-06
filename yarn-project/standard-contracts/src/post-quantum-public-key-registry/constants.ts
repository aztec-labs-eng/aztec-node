// Lightweight metadata leaf export for browser bundles: importing from
// `@aztec-labs/standard-contracts/post-quantum-public-key-registry/constants` avoids dragging in the
// `PostQuantumPublicKeyRegistry.json` static import.
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

import { StandardContractAddress, StandardContractClassId, StandardContractSalt } from '../standard_contract_data.js';

export const STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_ADDRESS: AztecAddress =
  StandardContractAddress.PostQuantumPublicKeyRegistry;
export const STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_CLASS_ID = StandardContractClassId.PostQuantumPublicKeyRegistry;
export const STANDARD_POST_QUANTUM_PUBLIC_KEY_REGISTRY_SALT = StandardContractSalt.PostQuantumPublicKeyRegistry;
