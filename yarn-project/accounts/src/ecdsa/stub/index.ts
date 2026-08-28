import { BaseAccount } from '@aztec-labs/aztec.js/account';
import type { CompleteAddress } from '@aztec-labs/aztec.js/addresses';
import { DefaultAccountEntrypoint } from '@aztec-labs/entrypoints/account';
import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';

import SimulatedEcdsaAccountJson from '../../../artifacts/SimulatedEcdsaAccount.json' with { type: 'json' };
import { StubBaseAccountContract } from '../../defaults/stub_account_contract.js';

export const StubEcdsaAccountContractArtifact = loadContractArtifact(SimulatedEcdsaAccountJson as NoirCompiledContract);

/** Stub account contract for ECDSA accounts (secp256k1 and secp256r1). Eagerly loads the contract artifact. */
export class StubEcdsaAccountContract extends StubBaseAccountContract {
  override getContractArtifact() {
    return Promise.resolve(StubEcdsaAccountContractArtifact);
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
