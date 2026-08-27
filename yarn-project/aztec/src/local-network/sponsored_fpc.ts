import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import {
  type ContractInstanceWithAddress,
  getContractInstanceFromInstantiationParams,
} from '@aztec-labs/aztec.js/contracts';
import { Fr } from '@aztec-labs/aztec.js/fields';
import type { Wallet } from '@aztec-labs/aztec.js/wallet';
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants';
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC';

async function getSponsoredFPCInstance(): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
}

export async function getSponsoredFPCAddress(): Promise<AztecAddress> {
  return (await getSponsoredFPCInstance()).address;
}

export async function registerDeployedSponsoredFPCInWalletAndGetAddress(wallet: Wallet): Promise<AztecAddress> {
  const fpc = await getSponsoredFPCInstance();
  // The following is no-op if the contract is already registered
  await wallet.registerContract(fpc, SponsoredFPCContract.artifact);
  return fpc.address;
}
