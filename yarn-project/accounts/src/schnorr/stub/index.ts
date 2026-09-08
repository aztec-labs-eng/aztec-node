import { BaseAccount } from '@aztec-labs/aztec.js/account';
import type { CompleteAddress } from '@aztec-labs/aztec.js/addresses';
import { DefaultAccountEntrypoint } from '@aztec-labs/entrypoints/account';
import { loadContractArtifact } from '@aztec-labs/stdlib/abi';
import type { NoirCompiledContract } from '@aztec-labs/stdlib/noir';

import SimulatedSchnorrAccountJson from '../../../artifacts/SimulatedSchnorrAccount.json' with { type: 'json' };
import { StubBaseAccountContract } from '../../defaults/stub_account_contract.js';

export const StubSchnorrAccountContractArtifact = loadContractArtifact(
  SimulatedSchnorrAccountJson as NoirCompiledContract,
);

/** Stub account contract for Schnorr accounts. Eagerly loads the contract artifact. */
export class StubSchnorrAccountContract extends StubBaseAccountContract {
  override getContractArtifact() {
    return Promise.resolve(StubSchnorrAccountContractArtifact);
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
