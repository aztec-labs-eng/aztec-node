import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { ProtocolContractAddress } from '@aztec-labs/protocol-contracts';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash';
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client';

/**
 * Returns the owner's fee juice balance.
 * Note: This is used only e2e_local_network_example test. TODO: Consider nuking.
 */
export async function getFeeJuiceBalance(owner: AztecAddress, node: AztecNode): Promise<bigint> {
  const slot = await deriveStorageSlotInMap(new Fr(1), owner);
  return (await node.getPublicStorageAt('latest', ProtocolContractAddress.FeeJuice, slot)).toBigInt();
}
