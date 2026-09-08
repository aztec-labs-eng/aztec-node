import type { InitialAccountData } from '@aztec-labs/accounts/testing';
import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing/lazy';
import type { AccountManager } from '@aztec-labs/aztec.js/wallet';
import type { Fq, Fr } from '@aztec-labs/foundation/curves/bn254';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';

interface WalletWithSchnorrAccounts {
  createSchnorrInitializerlessAccount(secret: Fr, salt: Fr, signingKey: Fq, alias?: string): Promise<AccountManager>;
}

/**
 * Creates the given (genesis-funded) test accounts as initializerless schnorr accounts. Initializerless
 * accounts need no deployment tx — creating one registers the instance and materializes its immutable keys
 * locally — so the accounts are usable as soon as they are created, funded via genesis at their addresses.
 */
export async function createFundedInitializerlessAccounts(
  wallet: WalletWithSchnorrAccounts,
  accountsData: InitialAccountData[],
) {
  const accountManagers = [];
  for (const { secret, salt, signingKey } of accountsData) {
    accountManagers.push(await wallet.createSchnorrInitializerlessAccount(secret, salt, signingKey));
  }
  return accountManagers;
}

export async function registerInitialLocalNetworkAccountsInWallet(
  wallet: WalletWithSchnorrAccounts,
): Promise<AztecAddress[]> {
  const testAccounts = await getInitialTestAccountsData();
  return Promise.all(
    testAccounts.map(async account => {
      return (await wallet.createSchnorrInitializerlessAccount(account.secret, account.salt, account.signingKey))
        .address;
    }),
  );
}
