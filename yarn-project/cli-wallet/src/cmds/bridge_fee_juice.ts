import { L1FeeJuicePortalManager } from '@aztec-labs/aztec.js/ethereum';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { ProtocolContractAddress } from '@aztec-labs/aztec.js/protocol';
import { prettyPrintJSON } from '@aztec-labs/cli/utils';
import { createEthereumChain } from '@aztec-labs/ethereum/chain';
import { createExtendedL1Client } from '@aztec-labs/ethereum/client';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { LogFn, Logger } from '@aztec-labs/foundation/log';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { getNonNullifiedL1ToL2MessageWitness } from '@aztec-labs/stdlib/messaging';

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
    const delayedCheck = (delay: number) => {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          void getNonNullifiedL1ToL2MessageWitness(
            node,
            ProtocolContractAddress.FeeJuice,
            Fr.fromHexString(messageHash),
            claimSecret,
          )
            .then(witness => resolve(witness))
            .catch(err => reject(err));
        }, delay);
      });
    };

    let witness;

    while (!witness) {
      witness = await delayedCheck(interval);
      if (!witness) {
        log(`No L1 to L2 message found yet, checking again in ${interval / 1000}s`);
      }
    }
  }

  return [claimSecret, messageLeafIndex] as const;
}
