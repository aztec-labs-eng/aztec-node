import { Fr } from '@aztec-labs/aztec.js/fields';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { getGenesisValues } from '@aztec-labs/world-state/testing';

/**
 * This test suit makes sure that the code in the monorepo is still compatible with the latest version of mainnet
 * Only update these values after a governance update that changes the protocol is enacted
 */
describe('Mainnet compatibility', () => {
  it('has expected VK tree root', () => {
    const expectedRoots = [Fr.fromHexString('0x258bc0b99bbadc087d8d8f7c78e4b41ba24c8d6979dbe698e00411bd7ec11891')];
    expect(expectedRoots).toContainEqual(getVKTreeRoot());
  });
  it('has expected Protocol Contracts tree root', () => {
    expect(protocolContractsHash).toEqual(
      Fr.fromHexString('0x04b0ccfafec7ff9a4a31c67c21377f73a8c01dcadc8710ee2a8e7751565db7f4'),
    );
  });
  it('has expected Genesis tree roots', async () => {
    // initial accounts get initial fee juice added to their balance
    const { genesisArchiveRoot } = await getGenesisValues(
      /* initial accounts */ [],
      /* initial fee juice */ Fr.ZERO,
      /* initial public data leaves */ [],
    );
    expect(genesisArchiveRoot).toEqual(
      Fr.fromHexString('0x0a0877e7fa8646252b46122976de111ece73d0cc054da8d780e3f12ec1709305'),
    );
  });
});
