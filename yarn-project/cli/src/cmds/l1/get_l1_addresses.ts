import { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { createEthereumChain } from '@aztec-labs/ethereum/chain';
import { RegistryContract } from '@aztec-labs/ethereum/contracts';
import type { ViemPublicClient } from '@aztec-labs/ethereum/types';
import type { LogFn } from '@aztec-labs/foundation/log';
import { createPublicClient, fallback, http } from 'viem';

export async function getL1Addresses(
  registryAddress: EthAddress,
  rollupVersion: number | bigint | 'canonical',
  rpcUrls: string[],
  chainId: number,
  json: boolean,
  log: LogFn,
) {
  const chain = createEthereumChain(rpcUrls, chainId);
  const publicClient: ViemPublicClient = createPublicClient({
    chain: chain.chainInfo,
    transport: fallback(rpcUrls.map(url => http(url, { batch: false }))),
    pollingInterval: 100,
  });
  const addresses = await RegistryContract.collectAddresses(publicClient, registryAddress.toString(), rollupVersion);

  if (json) {
    log(JSON.stringify(addresses, null, 2));
  } else {
    for (const [key, value] of Object.entries(addresses)) {
      log(`${key}: ${value.toString()}`);
    }
  }
}
