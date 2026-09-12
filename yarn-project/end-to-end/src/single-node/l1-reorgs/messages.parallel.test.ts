import { InboxAbi } from '@aztec-foundation/l1-artifacts';

import type { Archiver } from '@aztec-labs/archiver';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { type Logger, createLogger } from '@aztec-labs/aztec.js/log';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { InboxContract, RollupContract } from '@aztec-labs/ethereum/contracts';
import type { Delayer } from '@aztec-labs/ethereum/l1-tx-utils';
import type { ChainMonitor } from '@aztec-labs/ethereum/test';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { BlockNumber, CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import 'jest-extended';
import { type Hex, encodeFunctionData } from 'viem';

import { CheckpointProposalJobTestGate } from '../../fixtures/checkpoint_proposal_job_test_gate.js';
import { sendL1ToL2Message } from '../../fixtures/l1_to_l2_messaging.js';
import type { EndToEndContext } from '../../fixtures/utils.js';
import { waitForL1ToL2MessageSeen } from '../../shared/wait_for_l1_to_l2_message.js';
import type { SingleNodeTestContext } from '../single_node_test_context.js';
import { L1ReorgsTest, TX_COUNT } from './setup.js';

// Single-node + prover-node suite exercising L1 reorg behavior for L1→L2 cross-chain messages: removal
// of a sent message and insertion of a previously-cancelled message. An L1-client delayer holds back a
// message tx so a reorg can drop or replay it. Shared setup lives in setup.ts.
describe('single-node/l1-reorgs/messages', () => {
  let t: L1ReorgsTest;

  let context: EndToEndContext;
  let logger: Logger;
  let node: AztecNode;
  let archiver: Archiver;
  let monitor: ChainMonitor;

  let L1_BLOCK_TIME_IN_S: number;
  let L2_SLOT_DURATION_IN_S: number;

  let test: SingleNodeTestContext;

  let l1Client: ExtendedViemWalletClient;
  let l1ClientDelayer: Delayer;
  let gate: CheckpointProposalJobTestGate;
  let inbox: InboxContract;

  /** Block sub-slot duration in milliseconds on this suite's cadence, from FAST_REORG_TIMING. */
  const BLOCK_DURATION_MS = 5000;

  const sendTransactions = (count: number, offset = 0) => t.sendTransactions(count, offset);

  beforeEach(async () => {
    t = new L1ReorgsTest();
    gate = new CheckpointProposalJobTestGate(createLogger('e2e:l1-reorgs:messages:gate'), 180_000);
    await t.setup({ checkpointProposalJobTestHooks: gate.hooks });
    ({ test, context, logger, node, archiver, monitor } = t);
    ({ L1_BLOCK_TIME_IN_S, L2_SLOT_DURATION_IN_S } = t);
    ({ client: l1Client, delayer: l1ClientDelayer } = await test.createL1Client());
    inbox = new InboxContract(l1Client, context.deployL1ContractsValues.l1ContractAddresses.inboxAddress.toString());
  });

  afterEach(async () => {
    gate.release();
    await t.teardown();
  });

  const sendMessage = async () =>
    sendL1ToL2Message(
      { recipient: await AztecAddress.random(), content: Fr.random(), secretHash: Fr.random() },
      { l1ContractAddresses: context.deployL1ContractsValues.l1ContractAddresses, l1Client },
    );

  /**
   * Sends one L1-to-L2 message and returns it together with the exact `sendL2Message` call that produced it, so the
   * same call can be replayed verbatim under a different L1 block grouping. A message's leaf hash is derived from
   * sender, recipient, content, secret hash and version, none of which depend on which L1 block carried it, so a
   * replay of the same call from the same sender reproduces the same leaf at the same position.
   */
  const sendReplayableMessage = async () => {
    const { l1ContractAddresses } = context.deployL1ContractsValues;
    const recipient = await AztecAddress.random();
    const content = Fr.random();
    const secretHash = Fr.random();
    const version = BigInt(
      await new RollupContract(l1Client, l1ContractAddresses.rollupAddress.toString()).getVersion(),
    );
    const sent = await sendL1ToL2Message({ recipient, content, secretHash }, { l1ContractAddresses, l1Client });
    const call = {
      to: l1ContractAddresses.inboxAddress.toString() as Hex,
      from: l1Client.account.address,
      input: encodeFunctionData({
        abi: InboxAbi,
        functionName: 'sendL2Message',
        args: [{ actor: recipient.toString(), version }, content.toString(), secretHash.toString()],
      }),
    };
    return { ...sent, index: sent.globalLeafIndex.toBigInt(), call };
  };

  /** The live L1 bucket ending exactly at `total`, or undefined when no bucket ends there. */
  const liveBucketEndingAt = async (total: bigint) => {
    const found = await inbox.getBucketAtOrBeforeTotal(total);
    return found !== undefined && found.bucket.totalMsgCount === total ? found : undefined;
  };

  // A placement-only L1 reorg: the same ordered messages are re-mined under a different bucket partition, with the
  // cumulative count and rolling hash unchanged. Nothing about the content the proposer signed over has moved, so
  // the L2 block that already consumed both messages must survive: the claim is preservation of work in progress,
  // which is only demonstrable on block identity and same-slot publication, never on the messages merely
  // reappearing.
  //
  // The reorg happens while a non-final block of the current checkpoint is held at the checkpoint test gate, after
  // that block was stored by the proposer's own archiver and before the next block freezes its message range. The
  // replacement is a single atomic same-height `reorgWithReplacement` over pre-built calls: an intermediate shorter
  // message prefix would be a legal reason for the archiver to prune the held block, so one is never exposed.
  it('preserves the built block and its checkpoint across a placement-only L1 reorg', async () => {
    // Send L2 txs to trigger multi-block checkpoints and wait for them to land in a checkpoint
    await sendTransactions(TX_COUNT, 300);
    await test.waitUntilCheckpointNumber(CheckpointNumber(2), L2_SLOT_DURATION_IN_S * 6);

    // The reorg must not reach the parent checkpoint's own L1 publication, so the window opens after the most
    // recent publication rather than in the middle of one.
    const publishedBefore = await monitor.run(true);
    const l1BlockBeforeMessages = publishedBefore.l1BlockNumber;

    // Two messages in this order, each in its own L1 block and therefore its own bucket. Sends are sequential and
    // each awaits its own receipt, so the second cannot share the first's L1 block.
    logger.warn(`Sending two cross chain messages in separate L1 blocks`);
    const first = await sendReplayableMessage();
    const second = await sendReplayableMessage();
    expect(second.txReceipt.blockNumber).toBeGreaterThan(first.txReceipt.blockNumber);
    expect(second.index).toEqual(first.index + 1n);

    const firstEnd = first.index + 1n;
    const secondEnd = second.index + 1n;
    const bucketsBefore = {
      first: await liveBucketEndingAt(firstEnd),
      second: await liveBucketEndingAt(secondEnd),
    };
    // The premise of the scenario: the messages are split across two live buckets to begin with.
    expect(bucketsBefore.first).toBeDefined();
    expect(bucketsBefore.second).toBeDefined();
    expect(bucketsBefore.second!.seq).toBeGreaterThan(bucketsBefore.first!.seq);

    const stateBefore = await inbox.getState();
    expect(stateBefore.totalMessagesInserted).toEqual(secondEnd);

    // Hold the first non-final block of a checkpoint that has consumed through both messages.
    const armed = gate.arm(
      event =>
        event.phase === 'block-ready-to-broadcast' && event.isStandalone && event.consumedMessageCount >= secondEnd,
    );
    let held;
    try {
      held = await Promise.race([armed.matched, armed.failed]);
      logger.warn(`Holding block ${held.blockNumber} of checkpoint ${held.checkpointNumber} at slot ${held.slot}`, {
        consumedMessageCount: held.consumedMessageCount,
        remainingBuildSubslots: held.remainingBuildSubslots,
      });
      expect(held.remainingBuildSubslots).toBeGreaterThanOrEqual(1);

      // The held block really consumed both messages, at their original compact indices.
      for (const message of [first, second]) {
        const witness = await node.getL1ToL2MessageMembershipWitness(held.blockNumber, message.msgHash);
        expect(witness).toBeDefined();
        expect(witness![0]).toEqual(message.index);
      }

      // The reorg window: from the L1 block that carried the first message up to the current head. Its lower bound
      // is strictly above the last observed checkpoint publication, so no published checkpoint is inside it.
      const head = BigInt((await monitor.run(true)).l1BlockNumber);
      const reorgFrom = first.txReceipt.blockNumber;
      expect(reorgFrom).toBeGreaterThan(BigInt(l1BlockBeforeMessages));
      const depth = Number(head - reorgFrom + 1n);

      // Nothing else in the window may be dropped by the replacement. A rollup transaction inside it would be a
      // checkpoint publication or a proof, whose removal is a different scenario entirely, so the premise is
      // asserted rather than assumed.
      const rollupAddress = context.deployL1ContractsValues.l1ContractAddresses.rollupAddress.toString().toLowerCase();
      for (let n = reorgFrom; n <= head; n++) {
        const block = await l1Client.getBlock({ blockNumber: n, includeTransactions: true });
        const foreign = block.transactions.filter(tx => tx.to?.toLowerCase() === rollupAddress);
        expect(foreign).toHaveLength(0);
      }

      // Every replacement call is prepared before L1 is touched, and both go into one replacement block, so the
      // archiver never observes a state in which the message log is shorter than it was.
      logger.warn(`Replacing L1 blocks [${reorgFrom}, ${head}] with both messages in one block`, { depth });
      await context.cheatCodes.eth.reorgWithReplacement(depth, [[first.call, second.call]]);

      // The Inbox agrees on content and disagrees on placement.
      const stateAfter = await retryUntil(
        async () => {
          const state = await inbox.getState();
          return state.totalMessagesInserted === secondEnd ? state : undefined;
        },
        'Inbox re-inserts both messages after the replacement',
        L1_BLOCK_TIME_IN_S * 6,
        0.2,
      );
      expect(stateAfter.totalMessagesInserted).toEqual(stateBefore.totalMessagesInserted);
      expect(stateAfter.rollingHash.toString()).toEqual(stateBefore.rollingHash.toString());

      const bucketsAfter = {
        first: await liveBucketEndingAt(firstEnd),
        second: await liveBucketEndingAt(secondEnd),
      };
      // Placement changed: the boundary between the two messages is gone and both now end one bucket.
      expect(bucketsAfter.first).toBeUndefined();
      expect(bucketsAfter.second).toBeDefined();
      logger.warn(`Placement-only reorg complete`, {
        totalMessages: stateAfter.totalMessagesInserted,
        bucketsBefore: [bucketsBefore.first!.seq, bucketsBefore.second!.seq],
        bucketAfter: bucketsAfter.second!.seq,
      });

      // The archiver has reconciled to the replacement chain and still holds the held block's parent chain.
      await retryUntil(
        async () => (await archiver.getSyncedMessagePosition()).totalMessageCount >= secondEnd,
        'archiver reconciles to the replacement message log',
        L1_BLOCK_TIME_IN_S * 6,
        0.2,
      );
      expect((await node.getBlockData(held.blockNumber))?.blockHash.toString()).toEqual(held.blockHash.toString());

      const remaining = gate.remainingHoldBudgetMs()!;
      logger.warn(`Releasing with ${remaining}ms of proposal budget left`);
      expect(remaining).toBeGreaterThan(BLOCK_DURATION_MS);
    } finally {
      gate.release();
    }
    await armed.completed;

    // The already-built block was never pruned and never rebuilt: same number, same hash.
    const afterRelease = await node.getBlockData(held!.blockNumber);
    expect(afterRelease).toBeDefined();
    expect(afterRelease!.blockHash.toString()).toEqual(held!.blockHash.toString());
    expect(afterRelease!.checkpointNumber).toEqual(held!.checkpointNumber);

    // The same checkpoint number publishes, for the same slot: a later checkpoint taking its number would mean the
    // work was abandoned and redone, which is exactly what this scenario says must not happen.
    const published = await retryUntil(
      async () => {
        const [checkpoint] = await node.getCheckpoints(held!.checkpointNumber, 1, { includeBlocks: true });
        return checkpoint;
      },
      `checkpoint ${held!.checkpointNumber} publishes`,
      L2_SLOT_DURATION_IN_S * 4,
      0.5,
    );
    expect(published.header.slotNumber).toEqual(held!.slot);
    expect(published.blocks.map(block => block.number)).toContain(Number(held!.blockNumber));

    // Both messages keep their original compact indices and resolve witnesses on the canonical chain.
    for (const message of [first, second]) {
      expect(await node.getL1ToL2MessageIndex(message.msgHash)).toEqual(message.index);
      const witness = await node.getL1ToL2MessageMembershipWitness('latest', message.msgHash);
      expect(witness).toBeDefined();
      expect(witness![0]).toEqual(message.index);
      expect(await isL1ToL2MessageReady(node, message.msgHash)).toBe(true);
    }

    // The preserved checkpoint is proven by the fixture's prover node.
    const lastBlock = BlockNumber(published.blocks.at(-1)!.number);
    await retryUntil(
      async () => (await node.getBlockNumber('proven')) >= lastBlock,
      `proven tip reaches block ${lastBlock}`,
      L2_SLOT_DURATION_IN_S * t.test.epochDuration * 4,
      1,
    );

    // Verify multi-block checkpoints were built
    await test.assertMultipleBlocksPerSlot(2);
  });

  // Sends a first message, cancels a second message's L1 tx via delayer, waits for the archiver
  // to advance past the cancelled block, then reorgs to include the cancelled message. Sends a
  // third message on top and verifies all three are eventually seen by the node.
  it('handles missed message inserted by an L1 reorg', async () => {
    // Send L2 txs to trigger multi-block checkpoints and wait for them to land in a checkpoint
    await sendTransactions(TX_COUNT, 200);
    await test.waitUntilCheckpointNumber(CheckpointNumber(2), L2_SLOT_DURATION_IN_S * 6);

    // Send a message and wait for node to sync it
    logger.warn(`Sending first cross chain message`);
    const firstMsg = await sendMessage();
    logger.warn(`Sent first message on L1 block ${firstMsg.txReceipt.blockNumber}`);
    await waitForL1ToL2MessageSeen(node, firstMsg.msgHash, { timeoutSeconds: L1_BLOCK_TIME_IN_S * 3 });
    logger.warn(`Synced first message`);

    // Next message shall not land
    l1ClientDelayer.cancelNextTx();
    const secondMsgPromise = sendMessage();
    await retryUntil(() => l1ClientDelayer.getCancelledTxs().length, 'next msg tx', L1_BLOCK_TIME_IN_S, 0.1);

    // Wait until the archiver moves the syncpoint forward
    const l1BlockNumber = await monitor.run(true).then(m => m.l1BlockNumber);
    await retryUntil(() => archiver.getL1BlockNumber()! > l1BlockNumber, 'archiver sync', L1_BLOCK_TIME_IN_S * 2, 0.1);

    // Now trigger the reorg, where we insert the second message
    logger.warn(`Triggering reorg to insert second message`);
    const reorgDepth = (await monitor.run(true).then(m => m.l1BlockNumber)) - l1BlockNumber;
    await context.cheatCodes.eth.reorgWithReplacement(reorgDepth, [[l1ClientDelayer.getCancelledTxs()[0]]]);
    const secondMsg = await secondMsgPromise;
    await waitForL1ToL2MessageSeen(node, secondMsg.msgHash, { timeoutSeconds: L1_BLOCK_TIME_IN_S * 3 });

    // Archiver should see the new message and should be able to accept a third one on top, without any rolling hash issues
    logger.warn(`Reorged-in second message on L1 block ${secondMsg.txReceipt.blockNumber}. Sending third message.`);
    const thirdMsg = await sendMessage();
    await waitForL1ToL2MessageSeen(node, thirdMsg.msgHash, { timeoutSeconds: L1_BLOCK_TIME_IN_S * 3 });

    // Verify multi-block checkpoints were built
    await test.assertMultipleBlocksPerSlot(2);
  });
});
