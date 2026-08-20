import { type ContractArtifact, loadContractArtifact } from '@aztec/stdlib/abi';

import { makeStandardContract } from '../make_standard_contract.js';
import type { StandardContract } from '../standard_contract.js';

export {
  STANDARD_PUBLIC_CHECKS_ADDRESS,
  STANDARD_PUBLIC_CHECKS_CLASS_ID,
  STANDARD_PUBLIC_CHECKS_SALT,
} from './constants.js';

let standardContract: StandardContract;
let standardContractArtifact: ContractArtifact;

export async function getPublicChecksArtifact(): Promise<ContractArtifact> {
  if (!standardContractArtifact) {
    // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
    // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
    // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
    // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
    // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
    const { default: publicChecksJson } = await import('../../artifacts/PublicChecks.json');
    standardContractArtifact = loadContractArtifact(publicChecksJson);
  }
  return standardContractArtifact;
}

/** Returns the standard deployment of public_checks. */
export async function getStandardPublicChecks(): Promise<StandardContract> {
  if (!standardContract) {
    const artifact = await getPublicChecksArtifact();
    standardContract = makeStandardContract('PublicChecks', artifact);
  }
  return standardContract;
}
