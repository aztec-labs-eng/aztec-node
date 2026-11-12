import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';

async function getSponsoredFPCContract() {
  const { SponsoredFPCContract } = await import('@aztec-labs/noir-contracts.js/SponsoredFPC');
  return SponsoredFPCContract;
}

export async function getSponsoredFPCAddress(): Promise<AztecAddress> {
  const SponsoredFPCContract = await getSponsoredFPCContract();
  const sponsoredFPCInstance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return sponsoredFPCInstance.address;
}
