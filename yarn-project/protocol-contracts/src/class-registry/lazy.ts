import { type ContractArtifact, loadContractArtifact } from '@aztec/stdlib/abi';

import { makeProtocolContract } from '../make_protocol_contract.js';
import type { ProtocolContract } from '../protocol_contract.js';

export * from './contract_class_published_event.js';

let protocolContract: ProtocolContract;
let protocolContractArtifact: ContractArtifact;

export async function getContractClassRegistryArtifact(): Promise<ContractArtifact> {
  if (!protocolContractArtifact) {
    // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
    // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
    // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
    // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
    // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
    const { default: contractClassRegistryJson } = await import('../../artifacts/ContractClassRegistry.json');
    protocolContractArtifact = loadContractArtifact(contractClassRegistryJson);
  }
  return protocolContractArtifact;
}

/** Returns the canonical deployment of the auth registry. */
export async function getCanonicalClassRegistry(): Promise<ProtocolContract> {
  if (!protocolContract) {
    const contractClassRegistryArtifact = await getContractClassRegistryArtifact();
    protocolContract = makeProtocolContract('ContractClassRegistry', contractClassRegistryArtifact);
  }
  return protocolContract;
}
