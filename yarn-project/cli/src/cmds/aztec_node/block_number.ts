import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import type { LogFn } from '@aztec-labs/foundation/log';

export async function blockNumber(nodeUrl: string, log: LogFn) {
  const aztecNode = createAztecNodeClient(nodeUrl);
  const [latestNum, provenNum] = await Promise.all([aztecNode.getBlockNumber(), aztecNode.getBlockNumber('proven')]);
  log(`Latest block: ${latestNum}`);
  log(`Proven block: ${provenNum}`);
}
