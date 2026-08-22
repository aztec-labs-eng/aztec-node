import { BaseAccount } from '@aztec/aztec.js/account';
import type { CompleteAddress } from '@aztec/aztec.js/addresses';
import { DefaultAccountEntrypoint } from '@aztec/entrypoints/account';
import { loadContractArtifact } from '@aztec/stdlib/abi';

import { StubBaseAccountContract } from '../../defaults/stub_account_contract.js';

/**
 * Lazily loads the Schnorr stub contract artifact (browser-compatible).
 */
export async function getStubSchnorrAccountContractArtifact() {
  // Cannot add `with { type: 'json' }` to this import as it's incompatible with bundlers like vite
  // https://github.com/vitejs/vite/issues/19095#issuecomment-2566074352
  // Even if now supported by all major browsers, the MIME type is replaced with
  // "text/javascript"
  // In the meantime, this lazy import is INCOMPATIBLE WITH NODEJS
  const { default: json } = await import('../../../artifacts/SimulatedSchnorrAccount.json');
  return loadContractArtifact(json);
}

/** Stub account contract for Schnorr accounts. Lazily loads the contract artifact. */
export class StubSchnorrAccountContract extends StubBaseAccountContract {
  override getContractArtifact() {
    return getStubSchnorrAccountContractArtifact();
  }
}

/** Creates a Schnorr stub account that impersonates the one with the provided address. */
export function createStubSchnorrAccount(originalAddress: CompleteAddress) {
  const accountContract = new StubSchnorrAccountContract();
  const authWitnessProvider = accountContract.getAuthWitnessProvider(originalAddress);
  return new BaseAccount(
    new DefaultAccountEntrypoint(originalAddress.address, authWitnessProvider),
    authWitnessProvider,
    originalAddress,
  );
}
