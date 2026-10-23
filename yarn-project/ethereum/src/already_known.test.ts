import { RpcRequestError, UnknownRpcError } from 'viem';

import { isAlreadyKnownTxError } from './already_known.js';
import { L1RpcError } from './client.js';

/** Builds an error shaped like the one a send gets when the node answers with a JSON-RPC error. */
function makeSendError(message: string, code = -32000) {
  const rpcError = new RpcRequestError({
    body: { method: 'eth_sendRawTransaction', params: ['0x02'] },
    error: { code, message },
    url: 'http://localhost:8545',
  });
  return new UnknownRpcError(new L1RpcError('L1 RPC request failed', { cause: rpcError }));
}

describe('isAlreadyKnownTxError', () => {
  it.each([
    ['geth, reth and nethermind', 'already known'],
    ['besu', 'Known transaction'],
    ['erigon', 'ALREADY_EXISTS: already known'],
    ['anvil', 'transaction already imported'],
  ])('matches the error %s return for a tx already in their pool', (_, message) => {
    expect(isAlreadyKnownTxError(makeSendError(message))).toBe(true);
  });

  it.each([
    'nonce too low: next nonce 1, tx nonce 0',
    'replacement transaction underpriced',
    'unknown transaction',
    'insufficient funds for gas * price + value',
  ])('does not match %s', message => {
    expect(isAlreadyKnownTxError(makeSendError(message))).toBe(false);
  });

  it('matches through a cause chain deeper than the transport error', () => {
    const err = new Error('Failed to send L1 transaction', { cause: makeSendError('already known') });
    expect(isAlreadyKnownTxError(err)).toBe(true);
  });
});
