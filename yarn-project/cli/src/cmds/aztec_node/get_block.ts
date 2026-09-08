import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import type { LogFn } from '@aztec-labs/foundation/log';

import { inspectBlock } from '../../utils/inspect.js';

export async function getBlock(nodeUrl: string, maybeBlockNumber: number | undefined, log: LogFn) {
  const aztecNode = createAztecNodeClient(nodeUrl);
  const blockNumber: BlockNumber = maybeBlockNumber ? BlockNumber(maybeBlockNumber) : await aztecNode.getBlockNumber();
  await inspectBlock(aztecNode, blockNumber, log, { showTxs: true });
}
