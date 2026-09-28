import type { Archiver } from '@aztec-labs/archiver';
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { type Logger, createLogger } from '@aztec-labs/aztec.js/log';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import { InboxContract, MULTI_CALL_3_ADDRESS, RollupContract } from '@aztec-labs/ethereum/contracts';
import type { Delayer } from '@aztec-labs/ethereum/l1-tx-utils';
import type { ChainMonitor } from '@aztec-labs/ethereum/test';
import type { ExtendedViemWalletClient } from '@aztec-labs/ethereum/types';
import { BlockNumber, CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import {
  type L2Block,
  L2BlockSourceEvents,
  type L2PruneUncheckpointedEvent,
  type L2PruneUnprovenEvent,
} from '@aztec-labs/stdlib/block';
import { getSlotAtTimestamp } from '@aztec-labs/stdlib/epoch-helpers';
import 'jest-extended';
import type { Hex } from 'viem';

import { CheckpointProposalJobTestGate } from '../../fixtures/checkpoint_proposal_job_test_gate.js';
import {
  encodeSendL2MessageData,
  sendL1ToL2Message,
  sendL1ToL2MessagesInOneBlock,
} from '../../fixtures/l1_to_l2_messaging.js';
import { waitForCanonicalMessageSyncpoint } from '../../fixtures/message_syncpoint.js';
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
  let proverDelayer: Delayer;
  let gate: CheckpointProposalJobTestGate;
  let inbox: InboxContract;

  /** Block sub-slot duration in milliseconds on this suite's cadence, from FAST_REORG_TIMING. */
  const BLOCK_DURATION_MS = 5000;

  /**
   * L1 blocks the placement-only reorg reserves for itself: the two message sends plus the hold. The prover's next
   * submission is deferred past it before the window opens, and the window is asserted to have stayed inside it, so
   * "no rollup transaction was replaced away" is a bound set in advance rather than a hope checked afterwards.
   */
  const REORG_WINDOW_L1_BLOCKS = 16;

  const sendTransactions = (count: number, offset = 0) => t.sendTransactions(count, offset);

  beforeEach(async () => {
    t = new L1ReorgsTest();
    gate = new CheckpointProposalJobTestGate(createLogger('e2e:l1-reorgs:messages:gate'), 180_000);
    await t.setup({ checkpointProposalJobTestHooks: gate.hooks });
    ({ test, context, logger, node, archiver, monitor, proverDelayer } = t);
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
   * Sends two L1-to-L2 messages inside one L1 block, so the Inbox holds both in a single bucket, and returns each
   * together with the exact `sendL2Message` call that produced it, so the same calls can be replayed verbatim under
   * a different L1 block grouping. A message's leaf hash is derived from sender, recipient, content, secret hash and
   * version, none of which depend on which L1 block carried it, so a replay of the same calls from the same sender
   * reproduces the same leaves at the same positions.
   */
  const sendReplayableMessagePair = async () => {
    const { l1ContractAddresses } = context.deployL1ContractsValues;
    const version = BigInt(
      await new RollupContract(l1Client, l1ContractAddresses.rollupAddress.toString()).getVersion(),
    );
    const messages = [
      { recipient: await AztecAddress.random(), content: Fr.random(), secretHash: Fr.random() },
      { recipient: await AztecAddress.random(), content: Fr.random(), secretHash: Fr.random() },
    ];
    const sent = await sendL1ToL2MessagesInOneBlock(messages, { l1ContractAddresses, l1Client });
    return sent.map((message, index) => ({
      ...message,
      index: message.globalLeafIndex.toBigInt(),
      call: {
        to: l1ContractAddresses.inboxAddress.toString() as Hex,
        from: l1Client.account.address,
        input: encodeSendL2MessageData(messages[index], version),
        // Anvil estimates a replacement transaction against the chain before the rollback, where the pair's bucket
        // already exists and both appends are warm. Replayed after the rollback each call opens its own bucket cold
        // and costs far more, so an estimated limit runs out of gas and the message is never emitted.
        gas: 1_000_000n,
      },
    }));
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
  // The partition is split rather than merged: both messages start in one L1 block and one bucket, and the
  // replacement gives each its own block and bucket. Splitting only adds a boundary, so every bucket end that
  // existed before the reorg still exists after it. Merging would instead delete the boundary between the two
  // messages, and a checkpoint that has already been built on that boundary but has not reached L1 yet can then no
  // longer be published at all — its final message total is no longer any live bucket's end, so the proposer is
  // right to prune and rebuild, and the scenario would not be placement-only for that checkpoint.
  //
  // The reorg happens while a non-final block of the current checkpoint is held at the checkpoint test gate, after
  // that block was stored by the proposer's own archiver and before the next block freezes its message range. The
  // replacement is a single atomic same-height `reorgWithReplacement` over pre-built calls: an intermediate shorter
  // message prefix would be a legal reason for the archiver to prune the held block, so one is never exposed.
  it('preserves the built block and its checkpoint across a placement-only L1 reorg', async () => {
    // Send L2 txs to trigger multi-block checkpoints and wait for them to land in a checkpoint
    await sendTransactions(TX_COUNT, 300);
    await test.waitUntilCheckpointNumber(CheckpointNumber(2), L2_SLOT_DURATION_IN_S * 6);

    // Production is stopped before anything is sent. Pausing drains the in-flight checkpoint and its pending L1
    // submission, so the window the reorg will replace cannot contain a checkpoint publication, and no running
    // proposer can consume the messages before the gate exists to hold it.
    const sequencer = context.aztecNodeService.getSequencer()!;
    await sequencer.pause();

    // The reorg must not reach the parent checkpoint's own L1 publication, so the window opens after the most
    // recent publication rather than in the middle of one.
    const publishedBefore = await monitor.run(true);
    const l1BlockBeforeMessages = publishedBefore.l1BlockNumber;

    // The prover is the only rollup sender left once the sequencer is paused, and a proof landing inside the window
    // would be replaced away with it. Its next submission is deferred past the window before the window even opens
    // — installing this after the fact could not undo a proof that already landed — and it is a delay rather than a
    // cancellation, so the proof the suite still needs is only postponed. `pauseNextTxUntilBlock` consumes itself on
    // the next tx through the client; the `finally` below clears it if nothing did.
    proverDelayer.pauseNextTxUntilBlock(
      BigInt(l1BlockBeforeMessages) + BigInt(REORG_WINDOW_L1_BLOCKS),
      L1_BLOCK_TIME_IN_S * (REORG_WINDOW_L1_BLOCKS + 4),
    );

    // Two messages in this order, sharing one L1 block and therefore one bucket.
    logger.warn(`Sending two cross chain messages in a single L1 block`);
    const [first, second] = await sendReplayableMessagePair();
    expect(second.txReceipt.blockNumber).toEqual(first.txReceipt.blockNumber);
    expect(second.index).toEqual(first.index + 1n);

    const firstEnd = first.index + 1n;
    const secondEnd = second.index + 1n;
    const bucketsBefore = {
      first: await liveBucketEndingAt(firstEnd),
      second: await liveBucketEndingAt(secondEnd),
    };
    // The premise of the scenario: the messages share one live bucket, so no boundary sits between them and no
    // checkpoint can have ended on one.
    expect(bucketsBefore.first).toBeUndefined();
    expect(bucketsBefore.second).toBeDefined();

    const stateBefore = await inbox.getState();
    expect(stateBefore.totalMessagesInserted).toEqual(secondEnd);

    // Production resumes at the start of a build frame rather than wherever the sends happened to leave the clock.
    // Resuming late leaves one sub-slot, so the block that first consumes the messages is the checkpoint's *final*
    // block: not standalone, skipped by the gate, and published without ever being held. The reorg then lands on a
    // checkpoint nobody held, whose publication it invalidates, taking the held block down with it.
    const currentSlot = getSlotAtTimestamp(BigInt(await t.context.cheatCodes.eth.lastBlockTimestamp()), test.constants);
    await test.waitForBuildWindowForSlot(SlotNumber(Number(currentSlot) + 2));

    // Blocks pruned from anywhere in the chain while the reorg is in flight. Registered before L1 is touched: a
    // prune of the held block or of its ancestors is exactly what this scenario says must not happen, and a
    // post-hoc read of the chain cannot tell "never pruned" from "pruned and rebuilt to the same shape".
    const prunes: L2Block[] = [];
    const onPruneUnproven = (args: L2PruneUnprovenEvent) => prunes.push(...args.blocks);
    const onPruneUncheckpointed = (args: L2PruneUncheckpointedEvent) => prunes.push(...args.blocks);
    archiver.events.on(L2BlockSourceEvents.L2PruneUnproven, onPruneUnproven);
    archiver.events.on(L2BlockSourceEvents.L2PruneUncheckpointed, onPruneUncheckpointed);

    // The gate is armed synchronously by `withHold`, so creating the hold *before* restarting the sequencer is
    // what makes the arming precede production: a block consuming both messages cannot be built and gossiped
    // before there is anything to hold it.
    let held;
    try {
      const holding = gate.withHold(
        event =>
          event.phase === 'block-ready-to-broadcast' && event.isStandalone && event.consumedMessageCount >= secondEnd,
        async ctx => {
          const event = ctx.event;
          logger.warn(
            `Holding block ${event.blockNumber} of checkpoint ${event.checkpointNumber} at slot ${event.slot}`,
            {
              consumedMessageCount: event.consumedMessageCount,
              remainingBuildSubslots: event.remainingBuildSubslots,
            },
          );
          expect(ctx.canStartAnotherBlock()).toBe(true);

          // The held block really consumed both messages, at their original compact indices.
          for (const message of [first, second]) {
            const witness = await node.getL1ToL2MessageMembershipWitness(event.blockNumber, message.msgHash);
            expect(witness).toBeDefined();
            expect(witness![0]).toEqual(message.index);
          }

          // The reorg window: from the L1 block that carried the first message up to the current head. Its lower
          // bound is strictly above the last observed checkpoint publication, so no published checkpoint is inside
          // it, and production was stopped for the whole window until the gate was armed.
          const published = await monitor.run(true);
          const head = BigInt(published.l1BlockNumber);
          const reorgFrom = first.txReceipt.blockNumber;
          expect(reorgFrom).toBeGreaterThan(BigInt(l1BlockBeforeMessages));
          const depth = Number(head - reorgFrom + 1n);

          // The held block belongs to the first checkpoint built since production resumed, so no other checkpoint
          // reached L1 in between. A publication enqueued into this window would still be pending, invisible to
          // the transaction scan below, and would lose the Inbox endpoint it signed when the suffix is replaced.
          expect(published.checkpointNumber).toEqual(publishedBefore.checkpointNumber);
          expect(event.checkpointNumber).toEqual(publishedBefore.checkpointNumber + 1);

          // Nothing else in the window may be dropped by the replacement: a checkpoint publication or a proof
          // inside it would be a different scenario entirely. Both are sent through Multicall3 rather than
          // straight to the rollup, so checking the rollup address alone would miss every one of them.
          const { rollupAddress } = context.deployL1ContractsValues.l1ContractAddresses;
          const rollupSenders = [rollupAddress.toString(), MULTI_CALL_3_ADDRESS].map(address => address.toLowerCase());
          expect(BigInt(head) - reorgFrom).toBeLessThan(BigInt(REORG_WINDOW_L1_BLOCKS));
          for (let n = reorgFrom; n <= head; n++) {
            const block = await l1Client.getBlock({ blockNumber: n, includeTransactions: true });
            expect(block.transactions.filter(tx => rollupSenders.includes(tx.to?.toLowerCase() ?? ''))).toHaveLength(0);
          }

          // Every replacement call is prepared before L1 is touched and both replacement blocks are mined by the
          // one `anvil_reorg`, so the archiver never observes a state in which the message log is shorter than it
          // was, and it re-mines the whole depth, so the L1 height is preserved. Interval mining is paused across
          // the swap so the height and hash comparisons below read a chain that is not moving underneath them.
          expect(depth).toBeGreaterThanOrEqual(2);
          const anchorBefore = await l1Client.getBlock({ blockNumber: reorgFrom });
          const headBefore = await l1Client.getBlock({ blockNumber: BigInt(head) });
          logger.warn(`Replacing L1 blocks [${reorgFrom}, ${head}] with one message per block`, { depth });
          ctx.assertStillHeld('replace the L1 suffix');
          await context.cheatCodes.eth.execWithPausedAnvil(async () => {
            await context.cheatCodes.eth.reorgWithReplacement(depth, [[first.call], [second.call]]);

            // A different chain of the same height: the replacement re-mines every block it rolled back, so the
            // syncpoint check below cannot pass on a height the chain simply has not reached yet.
            const [anchorAfter, headAfter] = await Promise.all([
              l1Client.getBlock({ blockNumber: reorgFrom }),
              l1Client.getBlock({ blockNumber: BigInt(head) }),
            ]);
            expect(headAfter.number).toEqual(headBefore.number);
            expect(anchorAfter.hash).not.toEqual(anchorBefore.hash);
            expect(headAfter.hash).not.toEqual(headBefore.hash);
          });

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
          // Placement changed: a boundary now sits between the two messages and each ends its own bucket. The end
          // the messages already shared is still a live bucket end, so nothing already built on it has been
          // invalidated.
          expect(bucketsAfter.first).toBeDefined();
          expect(bucketsAfter.second).toBeDefined();
          expect(bucketsAfter.second!.seq).toBeGreaterThan(bucketsAfter.first!.seq);
          logger.warn(`Placement-only reorg complete`, {
            totalMessages: stateAfter.totalMessagesInserted,
            bucketBefore: bucketsBefore.second!.seq,
            bucketsAfter: [bucketsAfter.first!.seq, bucketsAfter.second!.seq],
          });

          // Count and rolling hash are identical either side of a placement-only reorg, so they cannot say which L1
          // chain the archiver's log belongs to. The message syncpoint can, but only with its hash checked against
          // the canonical chain at its own height: the pre-reorg syncpoint sits on the abandoned chain at a height
          // the replacement also reaches, so a height test alone is satisfied before anything reconciles. Requiring
          // the pre-reorg head height as well means the archiver has re-read the whole replaced suffix.
          const syncedTo = await waitForCanonicalMessageSyncpoint(
            archiver,
            {
              getCanonicalBlockHash: (l1BlockNumber: bigint) =>
                l1Client.getBlock({ blockNumber: l1BlockNumber }).then(
                  block => block.hash ?? undefined,
                  () => undefined,
                ),
            },
            {
              atLeastL1BlockNumber: BigInt(head),
              what: 'archiver certifies its message log against the replacement L1 chain',
              timeoutSeconds: L1_BLOCK_TIME_IN_S * 10,
              logger,
            },
          );
          logger.warn(`Archiver message log certified on the replacement chain`, {
            syncedL1Block: syncedTo.l1BlockNumber,
            preReorgHead: head,
          });
          expect((await archiver.getSyncedMessagePosition()).totalMessageCount).toEqual(secondEnd);
          expect((await node.getBlockData(event.blockNumber))?.blockHash.toString()).toEqual(
            event.blockHash.toString(),
          );

          const remaining = ctx.remainingHoldBudgetMs();
          logger.warn(`Releasing with ${remaining}ms of proposal budget left`, {
            nextSubslot: ctx.nextSubslot().index,
          });
          expect(ctx.canStartAnotherBlock()).toBe(true);
          expect(remaining).toBeGreaterThan(BLOCK_DURATION_MS);
          return event;
        },
      );
      // Attached before anything can reject: if the sequencer fails to restart, the hold's own failure must not
      // surface as an unhandled rejection while the start error propagates.
      holding.catch(() => {});
      await sequencer.start();
      held = await holding;

      // The already-built block was never pruned and never rebuilt: same number, same hash.
      const afterRelease = await node.getBlockData(held.blockNumber);
      expect(afterRelease).toBeDefined();
      expect(afterRelease!.blockHash.toString()).toEqual(held.blockHash.toString());
      expect(afterRelease!.checkpointNumber).toEqual(held.checkpointNumber);

      // The same checkpoint number publishes, for the same slot: a later checkpoint taking its number would mean the
      // work was abandoned and redone, which is exactly what this scenario says must not happen.
      const published = await retryUntil(
        async () => {
          const [checkpoint] = await node.getCheckpoints(held!.checkpointNumber, 1, { includeBlocks: true });
          return checkpoint;
        },
        `checkpoint ${held.checkpointNumber} publishes`,
        L2_SLOT_DURATION_IN_S * 4,
        0.5,
      );
      expect(published.header.slotNumber).toEqual(held.slot);
      expect(published.blocks.map(block => block.number)).toContain(Number(held.blockNumber));

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

      // Nothing the held block depends on was ever pruned: not the block itself, and not any of its ancestors.
      // Collected from the archiver's own prune events over the whole reorg-to-proof window.
      expect(prunes.filter(block => block.number <= held!.blockNumber)).toEqual([]);
    } finally {
      // Releases the gate whether the hold matched, the body threw, or the sequencer never restarted.
      gate.release();
      archiver.events.off(L2BlockSourceEvents.L2PruneUnproven, onPruneUnproven);
      archiver.events.off(L2BlockSourceEvents.L2PruneUncheckpointed, onPruneUncheckpointed);
      proverDelayer.nextWait = undefined;
    }

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
