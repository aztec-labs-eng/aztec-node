import { chunk } from '@aztec-labs/foundation/collection';
import { MAX_TX_SIZE_KB } from '@aztec-labs/stdlib/p2p';
import { TxArray, TxHash, TxHashArray } from '@aztec-labs/stdlib/tx';
import type { PeerId } from '@libp2p/interface';

import type { MemPools } from '../../../mem_pools/interface.js';
import type { ReqRespSubProtocolHandler } from '../interface.js';
import { ReqRespStatus, ReqRespStatusError } from '../status.js';

// Honest requesters chunk tx-fetch requests at 8 hashes (see chunkTxHashesRequest
// and the batch requester default). Reject anything far above that so one peer
// cannot ask for a huge number of txs in a single legal-size request.
const MAX_TX_HASHES_PER_REQUEST = 100;

/**
 * We want to keep the logic of the req resp handler in this file, but we do not have a reference to the mempools here
 * so we need to pass it in as a parameter.
 *
 * Handler for tx requests
 * @param mempools - the mempools
 * @returns the Tx request handler
 */
export function reqRespTxHandler(mempools: MemPools): ReqRespSubProtocolHandler {
  /**
   * Handler for tx requests
   * @param msg - the tx request message
   * @returns the tx response message
   * @throws if msg is not a valid tx hash
   */
  return async (_peerId: PeerId, msg: Buffer) => {
    let txHashes: TxHashArray;
    try {
      txHashes = TxHashArray.fromBuffer(msg);
    } catch (err: any) {
      throw new ReqRespStatusError(ReqRespStatus.BADLY_FORMED_REQUEST, { cause: err });
    }

    if (txHashes.length > MAX_TX_HASHES_PER_REQUEST) {
      throw new ReqRespStatusError(ReqRespStatus.BADLY_FORMED_REQUEST);
    }

    // De-duplicate before serving: without this a peer can repeat one hash many
    // times and make the node re-read and re-serialize the same tx per copy,
    // turning a legal-size request into a huge response.
    const uniqueByHash = new Map<string, TxHash>();
    for (const txHash of txHashes) {
      uniqueByHash.set(txHash.toString(), txHash);
    }

    try {
      const txs = new TxArray(
        ...(await Promise.all([...uniqueByHash.values()].map(txHash => mempools.txPool.getTxByHash(txHash)))).filter(
          t => !!t,
        ),
      );
      return txs.toBuffer();
    } catch (err: any) {
      throw new ReqRespStatusError(ReqRespStatus.INTERNAL_ERROR, { cause: err });
    }
  };
}

/**
 * Helper function to chunk an array of transaction hashes into chunks of a specified size.
 * This is mainly used in ReqResp in order not to request too many transactions at once from the single peer.
 *
 * @param hashes - The array of transaction hashes to chunk.
 * @param chunkSize - The size of each chunk. Default is 8. Reasoning:
 *  Per: https://github.com/AztecProtocol/aztec-packages/issues/15149#issuecomment-2999054485
 *  we define Q as max number of transactions per batch, the comment explains why we use 8.
 */
export function chunkTxHashesRequest(hashes: TxHash[], chunkSize = 8): Array<TxHashArray> {
  return chunk(hashes, chunkSize).map(chunk => new TxHashArray(...chunk));
}

/**
 * Calculate the expected response size for a TX request.
 * @param requestBuffer - The serialized request buffer containing TxHashArray
 * @returns Expected response size in KB
 */
export function calculateTxResponseSize(requestBuffer: Buffer): number {
  try {
    const txHashes = TxHashArray.fromBuffer(requestBuffer);
    // TxHashArray.fromBuffer returns empty array on parse failure, so check for that
    if (txHashes.length === 0 && requestBuffer.length > 0) {
      // If we got an empty array but had a non-empty buffer, parsing likely failed
      // Fall back to allowing a single transaction response
      return MAX_TX_SIZE_KB + 1;
    }
    return Math.max(txHashes.length, 1) * MAX_TX_SIZE_KB + 1; // +1 KB overhead, at least 1 tx
  } catch {
    // If we can't parse the request, fall back to allowing a single transaction response
    return MAX_TX_SIZE_KB + 1;
  }
}
