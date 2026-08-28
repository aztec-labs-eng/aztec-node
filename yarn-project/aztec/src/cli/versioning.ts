import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import { type ComponentsVersions, getComponentsVersionsFromConfig } from '@aztec-labs/stdlib/versioning';

export function getVersions(config?: ChainConfig): Partial<ComponentsVersions> {
  return config
    ? getComponentsVersionsFromConfig(config, protocolContractsHash, getVKTreeRoot())
    : {
        l2CircuitsVkTreeRoot: getVKTreeRoot().toString(),
        l2ProtocolContractsHash: protocolContractsHash.toString(),
      };
}
