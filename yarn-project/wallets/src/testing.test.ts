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

const LIST_ARTIFACTS_LOADED_ON_IMPORT_SCRIPT = `
import { registerHooks } from 'node:module';

const artifacts = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('/accounts/artifacts/')) {
      artifacts.push(url);
    }
    return nextLoad(url, context);
  },
});
await import('@aztec-labs/wallets/testing');
console.log(JSON.stringify(artifacts));
`;

async function runInNode(script: string): Promise<unknown> {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: PACKAGE_ROOT,
  });
  return JSON.parse(stdout);
}

describe('@aztec-labs/wallets/testing, loaded by Node.js from the built package without a transform', () => {
  it('registers the initial test accounts in the wallet', async () => {
    const initialTestAccounts = await getInitialTestAccountsData();
    expect(await runInNode(REGISTER_ACCOUNTS_SCRIPT)).toEqual(
      initialTestAccounts.map(({ address }) => address.toString()),
    );
  });

  it('loads no account contract artifact on import, so a browser bundle can load the artifacts lazily', async () => {
    expect(await runInNode(LIST_ARTIFACTS_LOADED_ON_IMPORT_SCRIPT)).toEqual([]);
  });
});
