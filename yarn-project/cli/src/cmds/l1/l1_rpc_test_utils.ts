import { RollupAbi } from '@aztec-foundation/l1-artifacts';

import { getPublicClient } from '@aztec-labs/ethereum/client';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createServer } from 'node:http';
import { decodeFunctionData, encodeAbiParameters } from 'viem';
import { foundry } from 'viem/chains';

/**
 * Starts a JSON-RPC server that reports `chainId` and, when `canonicalRollup` is given, answers every `eth_call` with
 * that address and records the call. Any other method gets an error.
 */
export async function serveL1Rpc(chainId: number, canonicalRollup?: EthAddress) {
  const registryCalls: { to: string; data: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      if (method === 'eth_chainId') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${chainId.toString(16)}` }));
      } else if (method === 'eth_call' && canonicalRollup) {
        registryCalls.push({ to: params[0].to, data: params[0].data });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: encodeAbiParameters([{ type: 'address' }], [canonicalRollup.toString() as `0x${string}`]),
          }),
        );
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    registryCalls,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Returns the `(attester, recipient)` arguments of the `initiateWithdraw` call that the latest block on an anvil chain
 * sent to `rollup`, failing if that block holds no such call.
 */
export async function getLatestInitiateWithdrawArgs(rpcUrl: string, rollup: EthAddress) {
  const client = getPublicClient({ l1RpcUrls: [rpcUrl], l1ChainId: foundry.id });
  const block = await client.getBlock({ includeTransactions: true });
  const tx = block.transactions.find(({ to }) => to !== null && rollup.equals(EthAddress.fromString(to)));
  if (!tx) {
    throw new Error(`No transaction to ${rollup} in the latest block`);
  }
  const decoded = decodeFunctionData({ abi: RollupAbi, data: tx.input });
  if (decoded.functionName !== 'initiateWithdraw') {
    throw new Error(`Expected initiateWithdraw, got ${decoded.functionName}`);
  }
  const [attester, recipient] = decoded.args;
  return { attester: EthAddress.fromString(attester), recipient: EthAddress.fromString(recipient) };
}
