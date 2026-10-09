import { Fr } from '@aztec-labs/aztec.js/fields';
import { testnetConfig } from '@aztec-labs/cli/config';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';

import { computeExpectedGenesisRoot } from './cli/cmds/standby.js';

/**
 * This test suit makes sure that the code in the monorepo is still compatible with the latest version of testnet
 * Only update these values after a governance update that changes the protocol is enacted
 */
describe('Testnet compatibility', () => {
  it('has expected VK tree root', () => {
    const expectedRoots = [Fr.fromHexString('0x13eeb174d4119b221a22721853261759f57a65a57e864ad78b840b23cde69e02')];
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
      { testAccounts: testnetConfig.TEST_ACCOUNTS, sponsoredFPC: testnetConfig.SPONSORED_FPC, prefundAddresses: [] },
      () => {},
    );

    expect(genesisArchiveRoot).toEqual(
      Fr.fromHexString('0x29eb2c527f8d45276430363214e6c8d709ef3f657a3670ebac3179373d41e5c4'),
    );
  });
});
