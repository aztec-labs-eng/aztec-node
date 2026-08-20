/**
 * The `@aztec/accounts/ecdsa` export provides an ECDSA account contract implementation, that uses an ECDSA private key for authentication, and a Grumpkin key for encryption.
 * Consider using this account type when working with integrations with Ethereum wallets.
 *
 * @packageDocumentation
 */
import type { ContractArtifact } from '@aztec/stdlib/abi';
import { loadContractArtifact } from '@aztec/stdlib/abi';

import { EcdsaRBaseAccountContract } from './account_contract.js';

/**
 * Lazily loads the contract artifact
 * @returns The contract artifact for the ecdsa K account contract
 */
export async function getEcdsaRAccountContractArtifact() {
  // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
  // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
  // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
  // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
  // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
  const { default: ecdsaKAccountContractJson } = await import('../../../artifacts/EcdsaRAccount.json');
  return loadContractArtifact(ecdsaKAccountContractJson);
}

/**
 * Account contract that authenticates transactions using ECDSA signatures
 * verified against a secp256k1 public key stored in an immutable encrypted note.
 * Lazily loads the contract artifact
 */
export class EcdsaRAccountContract extends EcdsaRBaseAccountContract {
  constructor(signingPrivateKey: Buffer) {
    super(signingPrivateKey);
  }

  override getContractArtifact(): Promise<ContractArtifact> {
    return getEcdsaRAccountContractArtifact();
  }
}
