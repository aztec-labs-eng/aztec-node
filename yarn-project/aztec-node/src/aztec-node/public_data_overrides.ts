import { PublicDataWrite } from '@aztec-labs/stdlib/avm';
import { computePublicDataTreeLeafSlot } from '@aztec-labs/stdlib/hash';
import type { PublicStorageOverride } from '@aztec-labs/stdlib/interfaces/client';
import type { MerkleTreeWriteOperations } from '@aztec-labs/stdlib/interfaces/server';
import { MerkleTreeId } from '@aztec-labs/stdlib/trees';

/**
 * Injects public-state overrides into an (ephemeral) world-state fork before simulation.
 *
 * Each override is written via the same `sequentialInsert` path the public processor
 * uses during real transaction execution, so low-leaf updates and root coherence are
 * handled identically for both simulation and proof generation.
 *
 * Writes never reach committed world state — the fork is thrown away after simulation.
 */
export async function applyPublicDataOverrides(
  fork: MerkleTreeWriteOperations,
  publicStorage: PublicStorageOverride[] | undefined,
): Promise<void> {
  if (!publicStorage?.length) {
    return;
  }

  const writes = await Promise.all(
    publicStorage.map(async o => {
      const leafSlot = await computePublicDataTreeLeafSlot(o.contract, o.slot);
      return new PublicDataWrite(leafSlot, o.value);
    }),
  );

  await fork.sequentialInsert(
    MerkleTreeId.PUBLIC_DATA_TREE,
    writes.map(w => w.toBuffer()),
  );
}
