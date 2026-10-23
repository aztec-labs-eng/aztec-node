/**
 * Messages L1 execution clients return from `eth_sendRawTransaction` when their pool already holds the exact tx sent:
 * geth, reth and nethermind say "already known", erigon "ALREADY_EXISTS: already known", besu "Known transaction",
 * and anvil "transaction already imported". The word boundary keeps "unknown transaction" from matching.
 */
const ALREADY_KNOWN_TX_PATTERN = /already known|\bknown transaction\b|already imported/i;

const MAX_ERR_DEPTH = 10;

/**
 * Returns whether a send failed because the node already holds this exact tx, which happens when a tx is sent again
 * after a node accepted it but its reply was lost. Looks at every error in the cause chain, since RPC errors reach the
 * caller wrapped by viem and the L1 transport. A "nonce too low" error does not match: it can mean that a different tx
 * took the nonce.
 */
export function isAlreadyKnownTxError(err: unknown): boolean {
  let current = err;
  for (let i = 0; current instanceof Error && i < MAX_ERR_DEPTH; i++) {
    const details = 'details' in current && typeof current.details === 'string' ? current.details : '';
    if (ALREADY_KNOWN_TX_PATTERN.test(`${current.message} ${details}`)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
