#!/usr/bin/env node
/* eslint-disable no-console */
import { makeL1HttpTransport } from '@aztec-labs/ethereum/client';
import { createLogger } from '@aztec-labs/foundation/log';
import { bufferToHex, hexToBuffer } from '@aztec-labs/foundation/string';
import { createPublicClient } from 'viem';

import { getBlobClientConfigFromEnv } from '../config.js';
import { createBlobClient } from '../factory.js';

async function main() {
  const logger = createLogger('blob-client');
  const blockHash = process.argv[2];
  if (!blockHash) {
    logger.error('Please provide a block hash as an argument.');
    process.exit(1);
  }
  const blobHashes = process.argv.slice(3).map(hexToBuffer);
  logger.info(`Fetching blobs for block hash ${blockHash}`);
  if (blobHashes.length > 0) {
    logger.info(`Filtering by blob hashes ${blobHashes.map(bufferToHex).join(', ')}`);
  }

  const config = getBlobClientConfigFromEnv();
  const l1Client = config.l1RpcUrls?.length
    ? createPublicClient({ transport: makeL1HttpTransport(config.l1RpcUrls, { timeout: config.l1HttpTimeoutMS }) })
    : undefined;
  const blobClient = createBlobClient(config, { l1Client });
  const blobs = await blobClient.getBlobSidecar(blockHash, blobHashes);
  logger.info(`Got ${blobs.length} blobs`);
  for (const blob of blobs) {
    console.log(blob.toJSON());
  }
}

// Example usage:
// $ L1_CHAIN_ID=11155111 LOG_LEVEL=trace yarn blob-client 0x7d81980a40426c40544f0f729ada953be406730b877b5865d6cdc35cc8f9c84e 0x010657f37554c781402a22917dee2f75def7ab966d7b770905398eba3c444014
main().catch(err => {
  console.error(err);
  process.exit(1);
});
