import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import { mockTx } from '@aztec-labs/stdlib/testing';
import { Tx } from '@aztec-labs/stdlib/tx';

import type { P2PConfig } from '../config.js';

/**
 * Helper function to create mock transactions with the correct metadata values
 * that will pass validation when sent over the p2p network.
 *
 * @param config - The P2P configuration containing chainId and rollupVersion
 * @param seed - Optional seed for the mock transaction
 * @returns A mock transaction with valid metadata for p2p network transmission
 */
export const createMockTxWithMetadata = (config: P2PConfig, seed?: number): Promise<Tx> => {
  return mockTx(seed, {
    chainId: new Fr(config.l1ChainId),
    version: new Fr(config.rollupVersion),
    vkTreeRoot: getVKTreeRoot(),
    protocolContractsHash,
  });
};
