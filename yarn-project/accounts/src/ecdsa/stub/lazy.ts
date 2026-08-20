import { BaseAccount } from '@aztec/aztec.js/account';
import type { CompleteAddress } from '@aztec/aztec.js/addresses';
import { DefaultAccountEntrypoint } from '@aztec/entrypoints/account';
import { loadContractArtifact } from '@aztec/stdlib/abi';

import { StubBaseAccountContract } from '../../defaults/stub_account_contract.js';

/**
 * Lazily loads the ECDSA stub contract artifact (browser-compatible).
 */
export async function getStubEcdsaAccountContractArtifact() {
  // Cannot add `with { type: 'json' }` (the import attribute formerly spelled `assert`): vite's dev server
  // serves JSON as a JS module ("text/javascript") and only strips the attribute from static imports, so the
  // browser's MIME check rejects the dynamic import: https://github.com/vitejs/vite/issues/19095
  // Without the attribute, Node's ESM loader rejects the import (ERR_IMPORT_ATTRIBUTE_MISSING), so this lazy
  // import is INCOMPATIBLE WITH NODEJS unless a bundler resolves the JSON at build time.
  const { default: json } = await import('../../../artifacts/SimulatedEcdsaAccount.json');
  return loadContractArtifact(json);
}

/** Stub account contract for ECDSA accounts (secp256k1 and secp256r1). Lazily loads the contract artifact. */
export class StubEcdsaAccountContract extends StubBaseAccountContract {
  override getContractArtifact() {
    return getStubEcdsaAccountContractArtifact();
  }
}

/** Creates an ECDSA stub account that impersonates the one with the provided address. */
export function createStubEcdsaAccount(originalAddress: CompleteAddress) {
  const accountContract = new StubEcdsaAccountContract();
  const authWitnessProvider = accountContract.getAuthWitnessProvider(originalAddress);
  return new BaseAccount(
    new DefaultAccountEntrypoint(originalAddress.address, authWitnessProvider),
    authWitnessProvider,
    originalAddress,
  );
}
