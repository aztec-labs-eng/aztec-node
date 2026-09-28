import { InboxAbi } from '@aztec-foundation/l1-artifacts';

import { RollupContract } from '@aztec-labs/ethereum/contracts';
import type { L1ContractAddresses } from '@aztec-labs/ethereum/l1-contract-addresses';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { tryJsonStringify } from '@aztec-labs/foundation/json-rpc';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { type Hex, type TransactionReceipt, decodeEventLog, encodeFunctionData, getContract } from 'viem';

import { getLogger } from './utils.js';

/** An L1-to-L2 message as the Inbox takes it. */
export type L1ToL2MessageInput = { recipient: AztecAddress; content: Fr; secretHash: Fr };

/** A sent L1-to-L2 message: its leaf hash, its global index in the message tree, and the L1 receipt that carried it. */
export type SentL1ToL2Message = { msgHash: Fr; globalLeafIndex: Fr; txReceipt: TransactionReceipt };

/** Reads the single `MessageSent` event the Inbox emits for one `sendL2Message` call. */
function readMessageSentEvent(txReceipt: TransactionReceipt, inboxAddress: string) {
  const messageSentLogs = txReceipt.logs
    .filter(log => log.address.toLowerCase() === inboxAddress.toLowerCase())
    .map(log => {
      try {
        const decoded = decodeEventLog({
          abi: InboxAbi,
          data: log.data,
          topics: log.topics,
        });
        return { log, decoded };
      } catch {
        return null; // Not a decodable event from this ABI
      }
    })
    .filter((item): item is { log: any; decoded: any } => item !== null && item.decoded.eventName === 'MessageSent');

  if (messageSentLogs.length !== 1) {
    throw new Error(
      `Wrong number of MessageSent logs found in ${txReceipt.transactionHash} transaction (got ${messageSentLogs.length} expected 1)\n${tryJsonStringify(messageSentLogs.map(item => item.log))}`,
    );
  }

  const topics = messageSentLogs[0].decoded;
  return {
    msgHash: Fr.fromHexString(topics.args.hash),
    globalLeafIndex: new Fr(topics.args.message.index),
  };
}

/** Encodes the `sendL2Message` calldata for an L1-to-L2 message at a given rollup version. */
export function encodeSendL2MessageData(message: L1ToL2MessageInput, version: bigint): Hex {
  return encodeFunctionData({
    abi: InboxAbi,
    functionName: 'sendL2Message',
    args: [{ actor: message.recipient.toString(), version }, message.content.toString(), message.secretHash.toString()],
  });
}

/**
 * Sends several L1-to-L2 messages so that a single L1 block carries all of them, which makes the Inbox open one
 * bucket for the whole group. Every transaction is submitted with an explicit consecutive nonce and none of them
 * waits for a receipt before the next is submitted, so the chain's miner has no opportunity to split the group.
 */
export async function sendL1ToL2MessagesInOneBlock(
  messages: L1ToL2MessageInput[],
  ctx: {
    l1Client: ExtendedViemWalletClient;
    l1ContractAddresses: Pick<L1ContractAddresses, 'inboxAddress' | 'rollupAddress'>;
  },
): Promise<SentL1ToL2Message[]> {
  const logger = getLogger();
  const inboxAddress = ctx.l1ContractAddresses.inboxAddress.toString();
  const version = BigInt(
    await new RollupContract(ctx.l1Client, ctx.l1ContractAddresses.rollupAddress.toString()).getVersion(),
  );
  const nonce = await ctx.l1Client.getTransactionCount({
    address: ctx.l1Client.account.address,
    blockTag: 'pending',
  });

  const txHashes = await Promise.all(
    messages.map((message, index) =>
      ctx.l1Client.sendTransaction({
        to: inboxAddress,
        data: encodeSendL2MessageData(message, version),
        gas: 1_000_000n,
        nonce: nonce + index,
      }),
    ),
  );
  logger.info(`Sent ${txHashes.length} L1 to L2 messages in txs ${txHashes.join(', ')}`);

  const receipts = await Promise.all(txHashes.map(hash => ctx.l1Client.waitForTransactionReceipt({ hash })));
  const failed = receipts.filter(receipt => receipt.status !== 'success');
  if (failed.length > 0) {
    throw new Error(`L1 to L2 messages failed to be sent in txs ${failed.map(r => r.transactionHash).join(', ')}`);
  }

  return receipts.map(txReceipt => ({ ...readMessageSentEvent(txReceipt, inboxAddress), txReceipt }));
}

export async function sendL1ToL2Message(
  message: { recipient: AztecAddress; content: Fr; secretHash: Fr },
  ctx: {
    l1Client: ExtendedViemWalletClient;
    l1ContractAddresses: Pick<L1ContractAddresses, 'inboxAddress' | 'rollupAddress'>;
  },
) {
  const logger = getLogger();
  const inbox = getContract({
    address: ctx.l1ContractAddresses.inboxAddress.toString(),
    abi: InboxAbi,
    client: ctx.l1Client,
  });

  const { recipient, content, secretHash } = message;

  const version = await new RollupContract(ctx.l1Client, ctx.l1ContractAddresses.rollupAddress.toString()).getVersion();

  // We inject the message to Inbox
  const txHash = await inbox.write.sendL2Message(
    [{ actor: recipient.toString(), version: BigInt(version) }, content.toString(), secretHash.toString()],
    {
      gas: 1_000_000n,
    },
  );
  logger.info(`L1 to L2 message sent in tx ${txHash}`);

  // We check that the message was correctly injected by checking the emitted event
  const txReceipt = await ctx.l1Client.waitForTransactionReceipt({ hash: txHash });

  if (txReceipt.status !== 'success') {
    throw new Error(`L1 to L2 message failed to be sent in tx ${txHash}. Status: ${txReceipt.status}`);
  }

  logger.info(`L1 to L2 message receipt retrieved for tx ${txReceipt.transactionHash}`, txReceipt);

  if (txReceipt.transactionHash !== txHash) {
    throw new Error(`Receipt transaction hash mismatch: ${txReceipt.transactionHash} !== ${txHash}`);
  }

  return {
    ...readMessageSentEvent(txReceipt, ctx.l1ContractAddresses.inboxAddress.toString()),
    txReceipt,
  };
}
