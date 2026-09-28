import type { InitialAccountData } from '@aztec-labs/accounts/testing';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { getSponsoredFPCAddress } from '@aztec-labs/cli/cli-utils';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { computeFeePayerBalanceLeafSlot } from '@aztec-labs/protocol-contracts/fee-juice';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { MerkleTreeId, PublicDataTreeLeaf } from '@aztec-labs/stdlib/trees';
import { NativeWorldStateService } from '@aztec-labs/world-state';
import { defaultInitialAccountFeeJuice } from '@aztec-labs/world-state/testing';

/**
 * This test suit makes sure that the code in the monorepo is still compatible with the latest version of testnet
 * Only update these values after a governance update that changes the protocol is enacted
 */
describe('Testnet compatibility', () => {
  it('has expected VK tree root', () => {
    const expectedRoots = [Fr.fromHexString('0x258bc0b99bbadc087d8d8f7c78e4b41ba24c8d6979dbe698e00411bd7ec11891')];
    expect(expectedRoots).toContainEqual(getVKTreeRoot());
  });
  it('has expected Protocol Contracts hash', () => {
    expect(protocolContractsHash).toEqual(
      Fr.fromHexString('0x04b0ccfafec7ff9a4a31c67c21377f73a8c01dcadc8710ee2a8e7751565db7f4'),
    );
  });
  // Testnet was initialized before the protocol contract registration nullifiers were seeded at genesis, so its root
  // is rebuilt from an empty nullifier tree rather than from today's default genesis.
  it('has expected Genesis tree roots', async () => {
    const initialAccounts: InitialAccountData[] = [];
    const sponsoredFPCAddress = await getSponsoredFPCAddress();
    const initialFundedAccounts = initialAccounts.map(a => a.address).concat(sponsoredFPCAddress);
    const genesisArchiveRoot = await historicalGenesisArchiveRoot(initialFundedAccounts, defaultInitialAccountFeeJuice);

    expect(genesisArchiveRoot).toEqual(
      Fr.fromHexString('0x271f7321aa0cb733bdee9ddd1b0497bb1b4b97eea2182cee0f516c19005ab2bf'),
    );
  });
});

/**
 * Rebuilds the genesis archive root of a network that was initialized before the protocol contract registration
 * nullifiers were seeded at genesis: an empty nullifier tree, only the deployment's fee-juice prefunding, timestamp 0.
 * `getGenesisValues` cannot express this any more, because it always seeds the canonical protocol baseline.
 */
async function historicalGenesisArchiveRoot(fundedAccounts: AztecAddress[], initialAccountFeeJuice: Fr) {
  const prefilledPublicData = await Promise.all(
    fundedAccounts.map(
      async address => new PublicDataTreeLeaf(await computeFeePayerBalanceLeafSlot(address), initialAccountFeeJuice),
    ),
  );
  prefilledPublicData.sort((a, b) => (b.slot.lt(a.slot) ? 1 : -1));

  const ws = await NativeWorldStateService.ephemeral({
    prefilledPublicData,
    prefilledNullifiers: [],
    genesisTimestamp: 0n,
  });
  try {
    return new Fr((await ws.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).root);
  } finally {
    await ws.close();
  }
}
