import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing';
import type { LogFn } from '@aztec-labs/foundation/log';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { getGenesisValues, measureCanonicalGenesis } from '@aztec-labs/world-state/testing';

import { getSponsoredFPCAddress } from '../../utils/setup_contracts.js';

/**
 * Computes and prints genesis values needed for L1 contract deployment.
 *
 * `genesisArchiveRoot` is this deployment's root, which depends on the accounts it prefunds. The `canonical` block is
 * the prefunding-free genesis that the `GENESIS_*` protocol constants record, and is what
 * `noir-projects/fnd/scripts/regenerate_genesis_constants.sh` reads to refresh them.
 */
export async function computeGenesisValuesCmd(testAccounts: boolean, sponsoredFPC: boolean, log: LogFn) {
  const initialAccounts = testAccounts ? await getInitialTestAccountsData() : [];
  const sponsoredFPCAddresses = sponsoredFPC ? await getSponsoredFPCAddress() : [];
  const initialFundedAccounts = initialAccounts.map(a => a.address).concat(sponsoredFPCAddresses);
  const { genesisArchiveRoot } = await getGenesisValues(initialFundedAccounts);
  const canonical = await measureCanonicalGenesis();

  const { getVKTreeRoot } = await import('@aztec-labs/noir-protocol-circuits-types/vk-tree');
  const vkTreeRoot = getVKTreeRoot();

  log(
    JSON.stringify(
      {
        vkTreeRoot: vkTreeRoot.toString(),
        protocolContractsHash: protocolContractsHash.toString(),
        genesisArchiveRoot: genesisArchiveRoot.toString(),
        canonical: {
          prefilledNullifiers: canonical.prefilledNullifiers.map(n => n.toString()),
          nullifierTreeRoot: canonical.nullifierTreeRoot.toString(),
          blockHeaderHash: canonical.blockHeaderHash.toString(),
          archiveRoot: canonical.archiveRoot.toString(),
        },
      },
      null,
      2,
    ),
  );
}
