import { MAX_TX_SIZE_KB } from '@aztec-labs/stdlib/p2p';
import { TxArray, TxHash, TxHashArray } from '@aztec-labs/stdlib/tx';
import type { PeerId } from '@libp2p/interface';

import type { MemPools } from '../../../mem_pools/interface.js';
import { DEFAULT_MAX_RESPONSE_SIZE_KB } from '../../encoding.js';
import type { ReqRespSubProtocolHandler } from '../interface.js';
import { ReqRespStatus, ReqRespStatusError } from '../status.js';

// Bound the request so the response the responder builds cannot exceed the reqresp
// transport's max response size: each hash yields up to MAX_TX_SIZE_KB, so cap the
// count at that budget. A peer naming more is rejected before the pool lookup, rather
// than forcing the node to read and serialize a response larger than the transport
// will carry. This node does not originate TX hash-list requests itself.
const MAX_TX_HASHES_PER_REQUEST = Math.floor(DEFAULT_MAX_RESPONSE_SIZE_KB / MAX_TX_SIZE_KB);

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
    // turning a small request into a much larger response.
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
