import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import type { LogFn } from '@aztec-labs/foundation/log';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { getGenesisValues } from '@aztec-labs/world-state/testing';

import { getSponsoredFPCAddress } from '../../utils/setup_contracts.js';

/** Computes and prints genesis values needed for L1 contract deployment. */
export async function computeGenesisValuesCmd(testAccounts: boolean, sponsoredFPC: boolean, log: LogFn) {
  const initialAccounts = testAccounts ? await getInitialTestAccountsData() : [];
  const sponsoredFPCAddresses = sponsoredFPC ? await getSponsoredFPCAddress() : [];
  const initialFundedAccounts = initialAccounts.map(a => a.address).concat(sponsoredFPCAddresses);
  const { genesisArchiveRoot } = await getGenesisValues(initialFundedAccounts);

  const { getVKTreeRoot } = await import('@aztec-labs/noir-protocol-circuits-types/vk-tree');
  const vkTreeRoot = getVKTreeRoot();

  log(
    JSON.stringify(
      {
        vkTreeRoot: vkTreeRoot.toString(),
        protocolContractsHash: protocolContractsHash.toString(),
        genesisArchiveRoot: genesisArchiveRoot.toString(),
      },
      null,
      2,
    ),
  );
}
