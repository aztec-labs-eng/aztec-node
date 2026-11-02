import { Fr } from '@aztec-labs/aztec.js/fields';
import { mainnetConfig, testnetConfig } from '@aztec-labs/cli/config';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';

import { computeExpectedGenesisRoot } from './cli/cmds/standby.js';

/**
 * Guards against protocol-breaking changes. These values belong to the protocol, not to any particular network, so only
 * update them together with an intentional protocol change.
 */
describe('Protocol compatibility', () => {
  it('has expected VK tree root', () => {
    const expectedRoots = [Fr.fromHexString('0x22fff5de6ce590153df4468f7f0b152188a803d91b3c9c648b91d93d5913f219')];
    expect(expectedRoots).toContainEqual(getVKTreeRoot());
  });
  it('has expected Protocol Contracts hash', () => {
    expect(protocolContractsHash).toEqual(
      Fr.fromHexString('0x0f54271c52865841a77aaa66036eed901aff22fdce9f08e123ec8b205c9854d7'),
    );
  });
});

/**
 * Guards against breaking testnet as deployed, or as about to be deployed. Update the expected root together with the
 * network's deployment; there is no need to wait for governance to execute it.
 */
describe('Testnet compatibility', () => {
  it('has expected genesis archive root', async () => {
    expect(await genesisArchiveRoot(testnetConfig)).toEqual(
      Fr.fromHexString('0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4'),
    );
  });
});

/**
 * Guards against breaking mainnet as deployed, or as about to be deployed. Update the expected root together with the
 * network's deployment; there is no need to wait for governance to execute it.
 */
describe('Mainnet compatibility', () => {
  it('has expected genesis archive root', async () => {
    expect(await genesisArchiveRoot(mainnetConfig)).toEqual(
      Fr.fromHexString('0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4'),
    );
  });
});

async function genesisArchiveRoot(network: { TEST_ACCOUNTS: boolean; SPONSORED_FPC: boolean }) {
  const { genesisArchiveRoot: root } = await computeExpectedGenesisRoot(
    { testAccounts: network.TEST_ACCOUNTS, sponsoredFPC: network.SPONSORED_FPC, prefundAddresses: [] },
    () => {},
  );
  return root;
}
