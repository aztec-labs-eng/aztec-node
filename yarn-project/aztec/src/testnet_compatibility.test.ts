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
    const expectedRoots = [Fr.fromHexString('0x031139abb5b9f51ca0e55a6e2022d567029f50acc9428506f05c91ae27e7f75d')];
    expect(expectedRoots).toContainEqual(getVKTreeRoot());
  });
  it('has expected Protocol Contracts hash', () => {
    expect(protocolContractsHash).toEqual(
      Fr.fromHexString('0x0030cdae9792549b9edb5b865f4e10e91bb87565f22ab80d405213f7e991b378'),
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
      Fr.fromHexString('0x2ef904bbd5edc11a43cf48c4270edbf631d14aeaddafe307f8fa959e8113bfb6'),
    );
  });
});
