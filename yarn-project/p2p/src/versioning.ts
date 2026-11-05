import type { Logger } from '@aztec-labs/foundation/log';
import { getVKTreeRoot } from '@aztec-labs/noir-protocol-circuits-types/vk-tree';
import { protocolContractsHash } from '@aztec-labs/protocol-contracts';
import type { ChainConfig } from '@aztec-labs/stdlib/config';
import {
  type ComponentsVersions,
  ComponentsVersionsError,
  checkCompressedComponentVersion,
  compressComponentVersions,
  getComponentsVersionsFromConfig,
} from '@aztec-labs/stdlib/versioning';
import type { BaseENR, SignableENR } from '@nethermindeth/enr';
import { Buffer } from 'buffer';

import { AZTEC_ENR_CLIENT_VERSION_KEY, AZTEC_ENR_KEY } from './types/index.js';

/** Returns the component versions based on config and this build. */
export function getVersions(config: ChainConfig) {
  return getComponentsVersionsFromConfig(config, protocolContractsHash, getVKTreeRoot());
}

/** Sets the aztec key on the ENR record with versioning info. */
export function setAztecEnrKey(enr: SignableENR, config: ChainConfig) {
  const versions = getVersions(config);
  enr.set(AZTEC_ENR_KEY, Buffer.from(compressComponentVersions(versions)));
  return versions;
}

/** Validates the Aztec ENR key against the supplied component versions. */
export function validateAztecEnrVersion(enr: BaseENR, expected: Partial<ComponentsVersions>, logger: Logger): boolean {
  const value = enr.kvs.get(AZTEC_ENR_KEY);
  if (!value) {
    logger.debug(`Peer node ${enr.nodeId} does not have aztec key in ENR`, { nodeId: enr.nodeId });
    return false;
  }

  let compressedVersion;
  try {
    compressedVersion = Buffer.from(value).toString();
    checkCompressedComponentVersion(compressedVersion, expected);
    return true;
  } catch (err) {
    if (err instanceof ComponentsVersionsError) {
      logger.debug(`Peer node ${enr.nodeId} has incorrect version: ${err.message}`, {
        nodeId: enr.nodeId,
        compressedVersion,
        expected,
      });
    } else {
      logger.error(`Error checking peer version`, { nodeId: enr.nodeId, err });
    }
    return false;
  }
}

/** Sets the Aztec client version on ENR record **/
export function setAztecClientVersionEnrKey(enr: SignableENR, clientVersion: string) {
  if (clientVersion) {
    enr.set(AZTEC_ENR_CLIENT_VERSION_KEY, Buffer.from(clientVersion));
  }
}
