import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { DEFAULT_GENESIS_DATA } from '@aztec-labs/protocol-contracts';
import { computeFeePayerBalanceLeafSlot } from '@aztec-labs/protocol-contracts/fee-juice';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { MerkleTreeId, PublicDataTreeLeaf } from '@aztec-labs/stdlib/trees';
import type { GenesisData } from '@aztec-labs/stdlib/world-state';

import { NativeWorldStateService } from './native/index.js';

async function generateGenesisValues(genesis: GenesisData) {
  // Compute the genesis values on a throwaway world state. The archive root derives deterministically from the
  // prefilled public data, the prefilled nullifiers, and the genesis timestamp, so the fsync-off ephemeral store (no
  // version manager, no crash-recoverability) produces an identical root while skipping the fsync overhead that `tmp`
  // pays. close() removes the tmpdir.
  const ws = await NativeWorldStateService.ephemeral(genesis);
  try {
    return {
      genesisArchiveRoot: new Fr((await ws.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).root),
    };
  } finally {
    await ws.close();
  }
}

/**
 * Measures every value the canonical genesis pins, from one world state.
 *
 * Canonical means {@link DEFAULT_GENESIS_DATA} exactly: the protocol contracts' registration nullifiers, no prefunded
 * public data and timestamp 0. That is what `GENESIS_NULLIFIER_TREE_ROOT`, `GENESIS_BLOCK_HEADER_HASH` and
 * `GENESIS_ARCHIVE_ROOT` in `constants.nr` record, so this is the measurement
 * `noir-projects/fnd/scripts/regenerate_genesis_constants.sh` writes back into them. A deployment that prefunds
 * accounts gets a different archive root and must use {@link getGenesisValues} instead.
 */
export async function measureCanonicalGenesis() {
  const ws = await NativeWorldStateService.ephemeral(DEFAULT_GENESIS_DATA);
  try {
    const committed = ws.getCommitted();
    return {
      prefilledNullifiers: DEFAULT_GENESIS_DATA.prefilledNullifiers,
      nullifierTreeRoot: new Fr((await committed.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).root),
      blockHeaderHash: await ws.getInitialHeader().hash(),
      archiveRoot: new Fr((await committed.getTreeInfo(MerkleTreeId.ARCHIVE)).root),
    };
  } finally {
    await ws.close();
  }
}

export const defaultInitialAccountFeeJuice = new Fr(10n ** 22n);

/**
 * Builds the genesis data and the resulting genesis archive root for a deployment.
 *
 * @param additionalNullifiers - Nullifiers to seed *in addition to* the canonical protocol contract registration
 * nullifiers that {@link DEFAULT_GENESIS_DATA} always contributes. Test networks pass e.g. the standard-contract
 * registration nullifiers here. Passing an empty list still yields the canonical protocol baseline, and passing the
 * full list of an already-resolved `GenesisData` is an error (duplicates are rejected rather than discarded) — such a
 * caller should hand the resolved object straight to the world state instead.
 */
export async function getGenesisValues(
  initialAccounts: AztecAddress[],
  initialAccountFeeJuice = defaultInitialAccountFeeJuice,
  genesisPublicData: PublicDataTreeLeaf[] = [],
  genesisTimestamp: bigint = 0n,
  additionalNullifiers: Fr[] = [],
) {
  // Top up the accounts with fee juice.
  let prefilledPublicData = await Promise.all(
    initialAccounts.map(
      async address => new PublicDataTreeLeaf(await computeFeePayerBalanceLeafSlot(address), initialAccountFeeJuice),
    ),
  );

  // Add user-defined public data
  prefilledPublicData = prefilledPublicData.concat(genesisPublicData);

  prefilledPublicData.sort((a, b) => (b.slot.lt(a.slot) ? 1 : -1));

  // The indexed nullifier tree requires its prefilled leaves to be unique and strictly increasing, so sort a copy
  // ascending rather than relying on the caller's ordering.
  const prefilledNullifiers = [...DEFAULT_GENESIS_DATA.prefilledNullifiers, ...additionalNullifiers].sort((a, b) =>
    a.toBigInt() < b.toBigInt() ? -1 : 1,
  );
  for (let i = 1; i < prefilledNullifiers.length; i++) {
    if (prefilledNullifiers[i].equals(prefilledNullifiers[i - 1])) {
      throw new Error(
        `Duplicate genesis nullifier ${prefilledNullifiers[i].toString()}: the protocol contract registration ` +
          `nullifiers are always seeded, so they must not be passed again as additional nullifiers.`,
      );
    }
  }

  const genesis: GenesisData = { prefilledPublicData, prefilledNullifiers, genesisTimestamp };
  const { genesisArchiveRoot } = await generateGenesisValues(genesis);

  return {
    genesisArchiveRoot,
    genesis,
    fundingNeeded: BigInt(initialAccounts.length) * initialAccountFeeJuice.toBigInt(),
  };
}
