import { type ContractArtifact, loadContractArtifact } from '@aztec/stdlib/abi';

import { makeStandardContract } from '../make_standard_contract.js';
import type { StandardContract } from '../standard_contract.js';

export {
  STANDARD_AUTH_REGISTRY_ADDRESS,
  STANDARD_AUTH_REGISTRY_CLASS_ID,
  STANDARD_AUTH_REGISTRY_SALT,
} from './constants.js';

let standardContract: StandardContract;
let standardContractArtifact: ContractArtifact;

export async function getAuthRegistryArtifact(): Promise<ContractArtifact> {
  if (!standardContractArtifact) {
    // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
    // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
    // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
    // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
    // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
    const { default: authRegistryJson } = await import('../../artifacts/AuthRegistry.json');
    standardContractArtifact = loadContractArtifact(authRegistryJson);
  }
  return standardContractArtifact;
}

/** Returns the standard deployment of the auth registry. */
export async function getStandardAuthRegistry(): Promise<StandardContract> {
  if (!standardContract) {
    const artifact = await getAuthRegistryArtifact();
    standardContract = makeStandardContract('AuthRegistry', artifact);
  }
  return standardContract;
}
