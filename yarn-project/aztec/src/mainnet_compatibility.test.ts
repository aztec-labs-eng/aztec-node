import { Fr } from '@aztec-labs/aztec.js/fields';
import { mainnetConfig } from '@aztec-labs/cli/config';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';

import { computeExpectedGenesisRoot } from './cli/cmds/standby.js';

/**
 * This test suit makes sure that the code in the monorepo is still compatible with the latest version of mainnet
 * Only update these values after a governance update that changes the protocol is enacted
 */
describe('Mainnet compatibility', () => {
  it('has expected VK tree root', () => {
    const expectedRoots = [Fr.fromHexString('0x22fff5de6ce590153df4468f7f0b152188a803d91b3c9c648b91d93d5913f219')];
    expect(expectedRoots).toContainEqual(getVKTreeRoot());
  });
  it('has expected Protocol Contracts hash', () => {
    expect(protocolContractsHash).toEqual(
      Fr.fromHexString('0x0f54271c52865841a77aaa66036eed901aff22fdce9f08e123ec8b205c9854d7'),
    );
  });
  // A node computes this at startup from the network's genesis flags, and stays in standby until the rollup's archive
  // root at block 0 matches it.
  it('has expected Genesis tree roots', async () => {
    const { genesisArchiveRoot } = await computeExpectedGenesisRoot(
      { testAccounts: mainnetConfig.TEST_ACCOUNTS, sponsoredFPC: mainnetConfig.SPONSORED_FPC, prefundAddresses: [] },
      () => {},
    );

    expect(genesisArchiveRoot).toEqual(
      Fr.fromHexString('0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4'),
    );
  });
});
