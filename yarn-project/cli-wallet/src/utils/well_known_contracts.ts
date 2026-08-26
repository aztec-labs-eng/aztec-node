import { ProtocolContractAddress } from '@aztec/aztec.js/protocol';
import { getSponsoredFPCAddress } from '@aztec/cli/cli-utils';
import type { LogFn } from '@aztec/foundation/log';
import { StandardContractAddress } from '@aztec/standard-contracts/data';
import type { AztecAddress } from '@aztec/stdlib/aztec-address';

import type { WalletDB } from '../storage/wallet_db.js';

/**
 * Aliases the well-known contracts missing from the wallet's database. Contracts that already have an alias are
 * skipped, so a user's own alias survives and older databases pick up new entries.
 */
export async function registerWellKnownContractAliases(db: WalletDB, log: LogFn) {
  for (const { name, getAddress } of wellKnownContracts) {
    if (await hasAlias(db, `contracts:${name}`)) {
      continue;
    }
    const address = (await getAddress()).toString();
    await db.storeAlias('contracts', name, Buffer.from(address), log);
    await db.storeAlias('artifacts', address, Buffer.from(name), log);
  }
}

/** A contract that commands can refer to by name, without the user having to know its address. */
type WellKnownContract = {
  name: string;
  getAddress: () => AztecAddress | Promise<AztecAddress>;
};

const wellKnownContracts: WellKnownContract[] = [
  ...Object.entries({ ...ProtocolContractAddress, ...StandardContractAddress }).map(([name, address]) => ({
    name,
    getAddress: () => address,
  })),
  // SponsoredFPC has no generated address record: it is instantiated with a zero salt, so its address is computed
  // from the current artifact.
  { name: 'SponsoredFPC', getAddress: getSponsoredFPCAddress },
];

async function hasAlias(db: WalletDB, alias: string) {
  try {
    return !!(await db.retrieveAlias(alias));
  } catch {
    return false;
  }
}
