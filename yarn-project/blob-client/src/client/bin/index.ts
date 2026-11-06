#!/usr/bin/env node
/* eslint-disable no-console */
import { createLogger } from '@aztec-labs/foundation/log';
import { bufferToHex, hexToBuffer } from '@aztec-labs/foundation/string';

import { getBlobClientConfigFromEnv } from '../config.js';
import { createBlobClient } from '../factory.js';

async function main() {
  const logger = createLogger('blob-client');
  const blockHash = process.argv[2];
  const timestamp = process.argv[3];
  if (!blockHash || !timestamp || !/^\d+$/.test(timestamp)) {
    logger.error('Please provide a block hash and its execution timestamp in seconds as arguments.');
    process.exit(1);
  }
  const l1BlockTimestamp = BigInt(timestamp);
  const blobHashes = process.argv.slice(4).map(hexToBuffer);
  logger.info(`Fetching blobs for block hash ${blockHash}`);
  if (blobHashes.length > 0) {
    logger.info(`Filtering by blob hashes ${blobHashes.map(bufferToHex).join(', ')}`);
  }

  const blobClient = createBlobClient(getBlobClientConfigFromEnv());
  await blobClient.start?.();
  try {
    const blobs = await blobClient.getBlobSidecar(blockHash, blobHashes, { l1BlockTimestamp });
    logger.info(`Got ${blobs.length} blobs`);
    for (const blob of blobs) {
      console.log(blob.toJSON());
    }
  } finally {
    blobClient.stop?.();
  }
}

// Example usage:
// $ L1_CHAIN_ID=11155111 LOG_LEVEL=trace yarn blob-client <block-hash> <timestamp-seconds> [blob-hash...]
main().catch(err => {
  console.error(err);
  process.exit(1);
});
