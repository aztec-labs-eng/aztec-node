import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import { describe, expect, it } from '@jest/globals';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

// @dependency ./testing.ts
const REGISTER_ACCOUNTS_SCRIPT = `
import { getSchnorrInitializerlessAccountContractAddress } from '@aztec-labs/accounts/schnorr';
import { registerInitialLocalNetworkAccountsInWallet } from '@aztec-labs/wallets/testing';

const wallet = {
  createSchnorrInitializerlessAccount: async (secret, salt, signingKey) => ({
    address: await getSchnorrInitializerlessAccountContractAddress(signingKey, salt, secret),
  }),
};
const addresses = await registerInitialLocalNetworkAccountsInWallet(wallet);
console.log(JSON.stringify(addresses.map(String)));
`;

describe('registerInitialLocalNetworkAccountsInWallet', () => {
  it('registers the initial test accounts when Node.js loads the built package without a transform', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '--eval', REGISTER_ACCOUNTS_SCRIPT],
      { cwd: PACKAGE_ROOT },
    );

    const initialTestAccounts = await getInitialTestAccountsData();
    expect(JSON.parse(stdout)).toEqual(initialTestAccounts.map(({ address }) => address.toString()));
  });
});
