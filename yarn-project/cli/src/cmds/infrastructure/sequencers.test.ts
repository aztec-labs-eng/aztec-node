import { L1ContractsNames } from '@aztec-labs/ethereum/l1-contract-addresses';
import { startAnvil } from '@aztec-labs/ethereum/test';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { ProtocolContractsNames } from '@aztec-labs/stdlib/contract';
import { type Server, createServer } from 'node:http';
import { foundry } from 'viem/chains';

import { getLatestInitiateWithdrawArgs } from '../l1/l1_rpc_test_utils.js';
import { sequencers } from './sequencers.js';

const mnemonic = 'test test test test test test test test test test test junk';
const who = EthAddress.random();
const recipient = EthAddress.random();
// The command only builds and sends the transaction, so any address without code accepts it.
const rollup = EthAddress.random();

/** Serves an Aztec node RPC that only answers getNodeInfo, reporting `rollup` as the rollup address. */
async function serveNodeInfo() {
  const nodeInfo = {
    nodeVersion: '6.0.0',
    l1ChainId: foundry.id,
    rollupVersion: 1,
    enr: 'enr',
    l1ContractAddresses: Object.fromEntries(
      L1ContractsNames.map(name => [name, (name === 'rollupAddress' ? rollup : EthAddress.random()).toString()]),
    ),
    protocolContractAddresses: Object.fromEntries(
      await Promise.all(ProtocolContractsNames.map(async name => [name, (await AztecAddress.random()).toString()])),
    ),
    realProofs: false,
    txsLimits: { gas: { daGas: 1, l2Gas: 1 } },
  };
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      const answer = ({ id, method }: { id: number; method: string }) =>
        method === 'aztec_getNodeInfo'
          ? { jsonrpc: '2.0', id, result: nodeInfo }
          : { jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported method' } };
      const parsed = JSON.parse(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

describe('sequencers remove', () => {
  let l1RpcUrl: string;
  let stopAnvil: () => Promise<void>;
  let node: Awaited<ReturnType<typeof serveNodeInfo>>;

  beforeAll(async () => {
    ({ rpcUrl: l1RpcUrl, stop: stopAnvil } = await startAnvil({ port: 0 }));
    node = await serveNodeInfo();
  });

  afterAll(async () => {
    await node?.close();
    await stopAnvil?.();
  });

  const remove = (recipientAddress: EthAddress | undefined, nodeUrl = node.url) =>
    sequencers({
      command: 'remove',
      who: who.toString(),
      recipient: recipientAddress,
      mnemonic,
      nodeUrl,
      l1RpcUrls: [l1RpcUrl],
      chainId: foundry.id,
      log: () => {},
    });

  it('initiates the withdrawal to the given recipient', async () => {
    await remove(recipient);

    expect(await getLatestInitiateWithdrawArgs(l1RpcUrl, rollup)).toEqual({ attester: who, recipient });
  });

  it('refuses to remove without a recipient before contacting the node', async () => {
    // Nothing listens on port 1, so reaching the node would fail with a connection error instead.
    await expect(remove(undefined, 'http://127.0.0.1:1')).rejects.toThrow('Missing --recipient');
  });
});
