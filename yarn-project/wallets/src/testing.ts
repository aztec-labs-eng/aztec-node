import type { InitialAccountData } from '@aztec-labs/accounts/testing';
import {
  INITIAL_TEST_ACCOUNT_SALTS,
  INITIAL_TEST_SECRET_KEYS,
  INITIAL_TEST_SIGNING_KEYS,
} from '@aztec-labs/accounts/testing/lazy';
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

export function registerInitialLocalNetworkAccountsInWallet(
  wallet: WalletWithSchnorrAccounts,
): Promise<AztecAddress[]> {
  return Promise.all(
    INITIAL_TEST_SECRET_KEYS.map(async (secret, i) => {
      const account = await wallet.createSchnorrInitializerlessAccount(
        secret,
        INITIAL_TEST_ACCOUNT_SALTS[i],
        INITIAL_TEST_SIGNING_KEYS[i],
      );
      return account.address;
    }),
  );
}
