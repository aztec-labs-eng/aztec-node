import { L1FeeJuicePortalManager } from '@aztec-labs/aztec.js/ethereum';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { ProtocolContractAddress } from '@aztec-labs/aztec.js/protocol';
import { prettyPrintJSON } from '@aztec-labs/cli/utils';
import { createEthereumChain } from '@aztec-labs/ethereum/chain';
import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { LogFn, Logger } from '@aztec-labs/foundation/log';
import { retryUntil } from '@aztec-labs/foundation/retry';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { computeFeeJuiceMessageNullifier, lookUpL1ToL2MessageWitness } from '@aztec-labs/stdlib/messaging';

export async function bridgeL1FeeJuice(
  amount: bigint,
  recipient: AztecAddress,
  node: AztecNode,
  l1RpcUrls: string[],
  chainId: number,
  privateKey: string | undefined,
  mnemonic: string,
  mint: boolean,
  json: boolean,
  wait: boolean,
  interval = 60_000,
  log: LogFn,
  debugLogger: Logger,
) {
  // Prepare L1 client
  const chain = createEthereumChain(l1RpcUrls, chainId);
  const client = createExtendedL1Client(chain.rpcUrls, privateKey ?? mnemonic, chain.chainInfo);

  // Setup portal manager
  const portal = await L1FeeJuicePortalManager.new(node, client, debugLogger);
  const { claimAmount, claimSecret, messageHash, messageLeafIndex } = await portal.bridgeTokensPublic(
    recipient,
    amount,
    mint,
  );

  if (json) {
    const out = {
      claimAmount,
      claimSecret,
      messageLeafIndex,
    };
    log(prettyPrintJSON(out));
  } else {
    if (mint) {
      log(`Minted ${claimAmount} fee juice on L1 and pushed to L2 portal`);
    } else {
      log(`Bridged ${claimAmount} fee juice to L2 portal`);
    }
    log(
      `claimAmount=${claimAmount},claimSecret=${claimSecret},messageHash=${messageHash},messageLeafIndex=${messageLeafIndex}\n`,
    );
    log(`Note: You need to wait for two L2 blocks before pulling them from the L2 side`);
    if (wait) {
      log(
        `This command will now continually poll every ${
          interval / 1000
        }s for the inclusion of the newly created L1 to L2 message`,
      );
    }
  }

  if (wait) {
    await waitForFeeJuiceClaimMessage(node, Fr.fromHexString(messageHash), claimSecret, interval, log);
  }

  return [claimSecret, messageLeafIndex] as const;
}

/**
 * Polls the node every `interval` ms until the fee juice claim's L1 to L2 message is in the message tree, and returns
 * its membership witness. Fails if the claim has already been consumed, since the message would never become
 * claimable again.
 */
export async function waitForFeeJuiceClaimMessage(
  node: AztecNode,
  messageHash: Fr,
  claimSecret: Fr,
  interval: number,
  log: LogFn,
) {
  const nullifier = await computeFeeJuiceMessageNullifier(messageHash, [claimSecret]);
  const unsiloedNullifier = { contractAddress: ProtocolContractAddress.FeeJuice, nullifier };
  return retryUntil(
    async () => {
      const lookup = await lookUpL1ToL2MessageWitness(node, messageHash, unsiloedNullifier, 'latest');
      switch (lookup.type) {
        case 'missing':
          log(`No L1 to L2 message found yet, checking again in ${interval / 1000}s`);
          return undefined;
        case 'nullified':
          throw new Error(`The fee juice claim for L1 to L2 message ${messageHash} has already been consumed`);
        case 'found':
          return lookup.witness;
      }
    },
    'L1 to L2 message',
    0,
    interval / 1000,
  );
}
