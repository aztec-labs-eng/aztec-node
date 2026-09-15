import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { NO_WAIT } from '@aztec-labs/aztec.js/contracts';
import { generateClaimSecret } from '@aztec-labs/aztec.js/ethereum';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { type Logger, createLogger } from '@aztec-labs/aztec.js/log';
import { isL1ToL2MessageReady, waitForL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { type AztecNode, waitForTx } from '@aztec-labs/aztec.js/node';
import { TxExecutionResult } from '@aztec-labs/aztec.js/tx';
import { BlockNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { TestContract } from '@aztec-labs/noir-test-contracts.js/Test';
import { jest } from '@jest/globals';

import { CheckpointProposalJobTestGate } from '../../fixtures/checkpoint_proposal_job_test_gate.js';
import { L1_DIRECT_WRITE_ACCOUNT_INDEX, PIPELINING_SETUP_OPTS } from '../../fixtures/fixtures.js';
import type { TestWallet } from '../../test-wallet/test_wallet.js';
import { proveInteraction } from '../../test-wallet/utils.js';
import { CrossChainMessagingTest } from './cross_chain_messaging_test.js';
import { createL1ToL2MessageHelpers } from './message_test_helpers.js';

// The suite runs a real (simulated-proof) prover node, so every case that waits for a checkpoint to be proven pays
// an epoch of block production before the proof lands. Matches the sibling prover-enabled bucket suite.
jest.setTimeout(900_000);

// Streaming Inbox e2e coverage the legacy per-checkpoint suite could not express: when every L1->L2 message
// entered at the first block of the *next* checkpoint, mid-checkpoint inclusion, message-only blocks, and
// per-block streaming latency had no observable surface. Runs the production
// pipelining sequencer via CrossChainMessagingTest with a widened slot (36s / 6s blocks -> up to ~4 blocks
// per checkpoint) so a message observed partway through a checkpoint's build lands in a non-first block.
// minTxsPerBlock=0 lets a checkpoint carry a zero-tx block whose only content is a streaming bundle.
//
// Grounded on l1_to_l2.test.ts (send/wait helpers, TestContract arbitrary-sender consume) and
// cross_chain_public_message.test.ts (same-block public consume). All cases share one node stood up once.
describe('single-node/cross-chain/streaming_inbox', () => {
  let t: CrossChainMessagingTest;

  let log: Logger;
  let aztecNode: AztecNode;
  let wallet: TestWallet;
  let user1Address: AztecAddress;
  let testContract: TestContract;
  let gate: CheckpointProposalJobTestGate;

  let sendMessageToL2: ReturnType<typeof createL1ToL2MessageHelpers>['sendMessageToL2'];
  let advanceBlock: ReturnType<typeof createL1ToL2MessageHelpers>['advanceBlock'];

  /** Block sub-slot duration in milliseconds, matching `blockDurationMs` below. */
  const BLOCK_DURATION_MS = 6000;

  beforeAll(async () => {
    gate = new CheckpointProposalJobTestGate(createLogger('e2e:streaming_inbox:gate'), 240_000);
    t = new CrossChainMessagingTest(
      'streaming_inbox',
      // A 36s slot with 6s blocks yields up to ~4 blocks per checkpoint (the pipelining timing model gives
      // maxBlocks = floor((36 - 0.5 - (0.5 + D)) / D) = 4 for D=6), which is what lets a message observed
      // mid-checkpoint land in a non-first block of the same checkpoint. minTxsPerBlock=0 permits
      // a zero-tx message-only block (the FI-05 relaxation). The prover node turns every proof claim in this
      // suite into a real wait on the production prover-node orchestration and the simulated protocol circuits,
      // so nothing here marks a tip proven by hand.
      {
        ...PIPELINING_SETUP_OPTS,
        aztecSlotDuration: 36,
        blockDurationMs: BLOCK_DURATION_MS,
        minTxsPerBlock: 0,
        startProverNode: true,
        checkpointProposalJobTestHooks: gate.hooks,
      },
      { aztecProofSubmissionEpochs: 2, aztecEpochDuration: 4 },
      { syncChainTip: 'checkpointed' },
      // Pass arbitrary L1->L2 messages straight to a TestContract; no token bridge needed.
      { l1HarnessAccountIndex: L1_DIRECT_WRITE_ACCOUNT_INDEX, deployTokenBridge: false },
    );
    await t.setup();

    ({ logger: log, wallet, user1Address, aztecNode } = t);
    ({ contract: testContract } = await TestContract.deploy(wallet).send({ from: user1Address }));

    ({ sendMessageToL2, advanceBlock } = createL1ToL2MessageHelpers({
      t,
      aztecNode,
      wallet,
      user1Address,
      log,
      // The prover node proves epochs; nothing is marked proven by hand in this suite, so a paused proof window
      // is a real failure rather than something the helpers paper over.
      markAsProven: () => Promise.resolve(),
    }));
  }, 600_000);

  afterAll(async () => {
    await t.teardown();
  });

  /** The L1 block timestamp at which an L1->L2 message was inserted, the origin of the latency bound. */
  const getMessageL1Timestamp = async (l1BlockNumber: bigint): Promise<bigint> => {
    const block = await t.harnessL1Client.getBlock({ blockNumber: l1BlockNumber });
    return block.timestamp;
  };

  /** Leaves in a block's committed L1-to-L2 message tree; genesis holds none and an unknown block reports none. */
  const committedMessageCount = async (blockNumber: number): Promise<bigint | undefined> => {
    if (blockNumber <= 0) {
      return 0n;
    }
    const data = await aztecNode.getBlockData(BlockNumber(blockNumber));
    return data && BigInt(data.header.state.l1ToL2MessageTree.nextAvailableLeafIndex);
  };

  /**
   * Finds the L2 block that inserted `msgHash` into the L1-to-L2 message tree. Under the streaming Inbox a message
   * enters the tree at the first block the proposer builds after its archiver observed it, which need not be the
   * first block of a checkpoint. Returns the block-data (checkpoint number + index within checkpoint) of that block.
   *
   * The tree is append-only, so every block built after the insertion resolves a membership witness for the message
   * just as the inserting one does: retaining membership is not inserting it, and scanning forward from a block
   * number sampled by the caller reports where the search started whenever the message was already inserted by then.
   * The block is instead located by the message's compact leaf index against the committed leaf count, which grows
   * monotonically along the chain: the inserting block is the first whose count is past the index, found by bisecting
   * the whole chain rather than trusting any sampled bound.
   *
   * The result is then confirmed at both states: the block's parent has no membership witness for the message and
   * the block itself resolves one at the message's own compact index. A chain that moves under the search (the tip
   * advancing, a prune) fails that confirmation, which is a genuine timing miss and is retried.
   */
  const findInsertingBlock = async (msgHash: Fr) => {
    const attempts = 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { leafIndex } = await retryUntil(
        async () => {
          const index = await aztecNode.getL1ToL2MessageIndex(msgHash);
          return index === undefined ? undefined : { leafIndex: index };
        },
        `node assigns a compact index to message ${msgHash.toString()}`,
        240,
        0.5,
      );

      // The chain holds the message once its tip's tree has grown past the message's index.
      const { tip } = await retryUntil(
        async () => {
          const tip = await aztecNode.getBlockNumber();
          const count = await committedMessageCount(tip);
          return count !== undefined && count > leafIndex ? { tip } : undefined;
        },
        `a block committing message ${msgHash.toString()}`,
        240,
        0.5,
      );

      // Bisect for the first block past the index: genesis holds no messages, the tip holds this one.
      let below = 0;
      let holding = Number(tip);
      while (holding - below > 1) {
        const middle = below + Math.floor((holding - below) / 2);
        const count = await committedMessageCount(middle);
        if (count !== undefined && count > leafIndex) {
          holding = middle;
        } else {
          below = middle;
        }
      }

      const blockNumber = BlockNumber(holding);
      const data = await aztecNode.getBlockData(blockNumber);
      const witness = await aztecNode.getL1ToL2MessageMembershipWitness(blockNumber, msgHash);
      const parentWitness =
        below === 0 ? undefined : await aztecNode.getL1ToL2MessageMembershipWitness(BlockNumber(below), msgHash);
      if (data !== undefined && witness !== undefined && witness[0] === leafIndex && parentWitness === undefined) {
        return { blockNumber, checkpointNumber: data.checkpointNumber, index: data.indexWithinCheckpoint };
      }
      log.warn(`Block ${blockNumber} did not confirm as the one inserting ${msgHash.toString()}; searching again`, {
        attempt,
        leafIndex,
        hasBlockData: data !== undefined,
        resolvedIndex: witness?.[0],
        parentHoldsMessage: parentWitness !== undefined,
      });
    }
    throw new Error(`Could not confirm which block inserted message ${msgHash.toString()} in ${attempts} attempts`);
  };

  /**
   * A read-only node view pinned to one concrete block: every message-tree question is answered at that block,
   * whatever the chain does afterwards. Readiness is a property of a block, and `latest`, `checkpointed` and
   * `proven` all move between two consecutive API calls, so an unpinned pair of assertions could pass or fail on
   * the tip advancing rather than on the block under test. The compact index is delegated to the real node, which
   * is chain-wide and not a property of any one block.
   */
  const pinnedTo = (blockNumber: BlockNumber) => ({
    getL1ToL2MessageIndex: (msgHash: Fr) => aztecNode.getL1ToL2MessageIndex(msgHash),
    getBlockData: () => aztecNode.getBlockData(blockNumber),
  });

  /** Waits until the prover node has proven through `blockNumber`. */
  const waitForProvenThrough = async (blockNumber: BlockNumber) => {
    await retryUntil(
      async () => (await aztecNode.getBlockNumber('proven')) >= blockNumber,
      `proven tip reaches block ${blockNumber}`,
      Number(t.constants.slotDuration) * t.epochDuration * 4,
      1,
    );
    expect(await aztecNode.getBlockNumber('proven')).toBeGreaterThanOrEqual(blockNumber);
  };

  /**
   * Runs `fn` while a background loop feeds empty txs, so checkpoints build multiple blocks promptly rather
   * than stalling on an empty pool. advanceBlock also refreshes the L1 proof window, keeping the chain from
   * pruning mid-test. Callers must pass a no-op `onNotReady` to any readiness wait so it does not send its own
   * wallet txs concurrently (which would race the feeder on the wallet nonce).
   */
  const withBackgroundFeeder = async <T>(fn: () => Promise<T>): Promise<T> => {
    let feeding = true;
    const feeder = (async () => {
      while (feeding) {
        try {
          await advanceBlock();
        } catch (err) {
          log.warn(`Feeder tx failed: ${(err as Error).message}`);
        }
      }
    })();
    try {
      return await fn();
    } finally {
      feeding = false;
      await feeder;
    }
  };

  // Test 1 (mid-checkpoint streaming, end to end): one checkpoint carries the whole streaming story. The test gate
  // holds the checkpoint's block zero after the proposer's archiver stored it and before the network or block one
  // sees it, which is the only barrier from which "the message did not exist for the parent and does for the
  // inserting block" is a statement about committed state rather than about when the test happened to look.
  //
  // While held the test sends the L1 message, watches the node index it without that making it ready, starts a
  // readiness wait against the proven tip that is demonstrably behind, and queues a public consume. Releasing lets
  // block one insert the message and execute the consume against its own post-bundle message root, so the same
  // block both inserts and spends it. The pending proven-tip wait then has to resolve on its own once the prover
  // node proves the covering checkpoint.
  it('streams a message into a non-first block, consumes it there, and proves the checkpoint', async () => {
    const l1Account = t.ethAccount;
    const [secret, secretHash] = await generateClaimSecret();

    // Readiness for a hash the chain has never seen is false before anything is sent, so the true answers below
    // are not an artifact of the helper answering true for everything.
    expect(await isL1ToL2MessageReady(aztecNode, Fr.random())).toBe(false);

    // Hold the first block of a checkpoint that still has sub-slots left to build the message into.
    const armed = gate.arm(
      event => event.phase === 'block-ready-to-broadcast' && event.indexWithinCheckpoint === 0 && event.isStandalone,
    );
    let consumeTxHash;
    let msgHash: Fr;
    let messageContent: Fr;
    let globalLeafIndex: bigint;
    let provenReady: Promise<boolean>;
    let held;
    try {
      held = await Promise.race([armed.matched, armed.failed]);
      log.warn(`Holding block ${held.blockNumber} of checkpoint ${held.checkpointNumber}`, {
        slot: held.slot,
        remainingBuildSubslots: held.remainingBuildSubslots,
        consumedMessageCount: held.consumedMessageCount,
      });
      // The checkpoint has room for the block that will carry the message.
      expect(held.remainingBuildSubslots).toBeGreaterThanOrEqual(1);

      const message = { recipient: testContract.address, content: Fr.random(), secretHash };
      messageContent = message.content;
      const sent = await sendMessageToL2(message);
      msgHash = sent.msgHash;
      globalLeafIndex = sent.globalLeafIndex.toBigInt();

      // The node indexes the message while production is held: observing and indexing a message is not the same
      // as a block having inserted it, and readiness has to report the latter.
      await retryUntil(
        async () => {
          const index = await aztecNode.getL1ToL2MessageIndex(msgHash);
          return index === undefined ? undefined : { index };
        },
        `node assigns a compact index to message ${msgHash.toString()}`,
        Number(t.constants.ethereumSlotDuration) * 6,
        0.2,
      );
      expect(await aztecNode.getL1ToL2MessageIndex(msgHash)).toEqual(globalLeafIndex);
      expect(await isL1ToL2MessageReady(aztecNode, msgHash, 'latest')).toBe(false);

      // Started here, while the proven tip is demonstrably behind the message: the helper has to poll to a true
      // answer rather than being called once readiness is already established.
      expect(await isL1ToL2MessageReady(aztecNode, msgHash, 'proven')).toBe(false);
      provenReady = waitForL1ToL2MessageReady(aztecNode, msgHash, {
        timeoutSeconds: Number(t.constants.slotDuration) * t.epochDuration * 4,
        chainTip: 'proven',
      });

      // Queue the consume while the checkpoint is held, so the block that inserts the message can also spend it.
      const consume = await proveInteraction(
        wallet,
        testContract.methods.consume_message_from_arbitrary_sender_public(
          message.content,
          secret,
          l1Account,
          globalLeafIndex,
        ),
        { from: user1Address },
      );
      consumeTxHash = await consume.send({ wait: NO_WAIT });
      log.warn(`Queued consume tx ${consumeTxHash.toString()} while checkpoint ${held.checkpointNumber} is held`);

      // The hold spends the proposer's real budget. Releasing into a spent deadline would abandon the slot and
      // make every assertion below fail for the wrong reason, so the budget is checked rather than assumed.
      const remaining = gate.remainingHoldBudgetMs()!;
      log.warn(`Releasing with ${remaining}ms of proposal budget left`);
      expect(remaining).toBeGreaterThan(BLOCK_DURATION_MS * 2);
    } finally {
      gate.release();
    }
    await armed.completed;

    // The message entered the tree at a block of the held checkpoint, past its first.
    const inserting = await findInsertingBlock(msgHash!);
    log.warn(`Message ${msgHash!.toString()} inserted at block ${inserting.blockNumber}`, {
      checkpointNumber: inserting.checkpointNumber,
      index: inserting.index,
      heldCheckpoint: held!.checkpointNumber,
    });
    expect(inserting.checkpointNumber).toEqual(held!.checkpointNumber);
    expect(inserting.index).toBeGreaterThan(0);
    expect(inserting.blockNumber).toBeGreaterThan(held!.blockNumber);

    // The parent did not hold the message and the inserting block does, at the compact index L1 assigned.
    const parent = BlockNumber(inserting.blockNumber - 1);
    expect(await aztecNode.getL1ToL2MessageMembershipWitness(parent, msgHash!)).toBeUndefined();
    const witness = await aztecNode.getL1ToL2MessageMembershipWitness(inserting.blockNumber, msgHash!);
    expect(witness).toBeDefined();
    expect(witness![0]).toEqual(globalLeafIndex!);

    // Readiness pinned to those two blocks: false at the parent, true at the inserting block. Pinning is what
    // makes this a statement about the two blocks rather than about the tip moving between the two calls.
    expect(await isL1ToL2MessageReady(pinnedTo(parent), msgHash!)).toBe(false);
    expect(await isL1ToL2MessageReady(pinnedTo(inserting.blockNumber), msgHash!)).toBe(true);

    // Same-block consumption: the block's constant data pins the message root to its own post-bundle value, so the
    // public call sees the message the same block just inserted.
    const consumeReceipt = await waitForTx(aztecNode, consumeTxHash!, {
      timeout: Number(t.constants.slotDuration) * 4,
    });
    expect(consumeReceipt.executionResult).toBe(TxExecutionResult.SUCCESS);
    expect(consumeReceipt.blockNumber).toEqual(Number(inserting.blockNumber));

    // The leaf is nullified, so a second consume of the same message reverts.
    const { receipt: doubleSpend } = await testContract.methods
      .consume_message_from_arbitrary_sender_public(messageContent!, secret, l1Account, globalLeafIndex!)
      .send({ from: user1Address, wait: { dontThrowOnRevert: true } });
    expect(doubleSpend.executionResult).toBe(TxExecutionResult.REVERTED);

    // The prover node proves the covering checkpoint, and the readiness wait started against the proven tip while
    // the checkpoint was still being built resolves on its own once it does.
    await waitForProvenThrough(inserting.blockNumber);
    expect(await provenReady!).toBe(true);
    expect(await isL1ToL2MessageReady(aztecNode, msgHash!, 'proven')).toBe(true);

    // The proven chain holds both the insertion and the successful consume.
    const provenBlock = (await aztecNode.getBlock(inserting.blockNumber, { includeTransactions: true }))!;
    expect(await aztecNode.getL1ToL2MessageMembershipWitness(inserting.blockNumber, msgHash!)).toBeDefined();
    expect(provenBlock.body.txEffects.map(effect => effect.txHash.toString())).toContain(consumeTxHash!.toString());
  });

  // Test 2 (latency bound): the delay between a message's L1 inclusion and the L2 block that makes it
  // available stays within the streaming bound. Asserted in slot-denominated terms (L1/L2 timestamps, not
  // wall-clock): the including block's timestamp minus the message's L1 timestamp must be at most
  // ethereumSlotDuration + 2 * slotDuration (one L1 block for the proposer's archiver to observe the message +
  // a full slot straddle + one slot of CI slack). No lower bound is asserted: blocks consume observed messages
  // as soon as they are built. The wall-clock latency is logged for information only.
  it('makes a message available within the streaming latency bound', async () => {
    const { slotDuration } = t.constants;
    const maxDelaySeconds = BigInt(t.constants.ethereumSlotDuration) + 2n * BigInt(slotDuration);

    await withBackgroundFeeder(async () => {
      const wallClockAtSend = Date.now();
      const [, secretHash] = await generateClaimSecret();
      const message = { recipient: testContract.address, content: Fr.random(), secretHash };
      const { msgHash, txReceipt } = await sendMessageToL2(message);
      const messageL1Ts = await getMessageL1Timestamp(txReceipt.blockNumber!);
      log.warn(`Sent message ${msgHash.toString()} with L1 timestamp ${messageL1Ts}`);

      // The background feeder drives block production; findInsertingBlock polls the committed tree without
      // sending its own wallet txs (which would race the feeder on the nonce).
      const inserting = await findInsertingBlock(msgHash);
      const wallClockLatencyMs = Date.now() - wallClockAtSend;
      const insertingBlock = (await aztecNode.getBlock(inserting.blockNumber))!;
      const includingBlockTs = insertingBlock.header.globalVariables.timestamp;
      const delaySeconds = includingBlockTs - messageL1Ts;

      // Informational only: the wall-clock number flakes under CI load, so it is never
      // asserted on; the slot-denominated bound below is the real check.
      log.warn(`Streaming latency for message ${msgHash.toString()}`, {
        messageL1Ts,
        includingBlockTs,
        delaySeconds: Number(delaySeconds),
        maxDelaySeconds: Number(maxDelaySeconds),
        wallClockLatencyMs,
      });

      expect(delaySeconds).toBeGreaterThan(0n);
      expect(delaySeconds).toBeLessThanOrEqual(maxDelaySeconds);
    });
  });

  // Test 3 (message-only block): on an empty tx pool, the block that consumes a message carries zero txs and a
  // non-empty streaming bundle (the FI-05 shape exercised on a live chain), and the chain keeps proving past
  // it. Drains the pool first, then sends a single message and asserts the inserting block has no tx effects.
  it('produces a message-only block on an empty tx pool and keeps proving', async () => {
    // Let the pool drain so the checkpoint that consumes the message is not padded with unrelated txs.
    await retryUntil(
      async () => !(await aztecNode.getPendingTxCount()),
      'tx pool drains',
      Number(t.constants.slotDuration) * 3,
      0.5,
    );

    const [, secretHash] = await generateClaimSecret();
    const message = { recipient: testContract.address, content: Fr.random(), secretHash };
    const { msgHash } = await sendMessageToL2(message);
    log.warn(`Sent message ${msgHash.toString()} on an empty pool`);

    // Do not feed txs; the sequencer builds empty checkpoints until the message ages past the lag, at which
    // point a zero-tx block consumes it. findInsertingBlock polls the committed tree without sending txs, so
    // the pool stays empty and the block that consumes the message carries only the bundle.
    const inserting = await findInsertingBlock(msgHash);

    const insertingBlock = (await aztecNode.getBlock(inserting.blockNumber, { includeTransactions: true }))!;
    log.warn(`Message ${msgHash.toString()} inserted at block ${inserting.blockNumber}`, {
      checkpointNumber: inserting.checkpointNumber,
      index: inserting.index,
      txCount: insertingBlock.body.txEffects.length,
    });

    // The inserting block carried the message with no txs: a message-only block.
    expect(insertingBlock.body.txEffects.length).toBe(0);
    // Its bundle was non-empty, shown by the leaf-count delta against its parent and by the witness the block
    // resolves at the message's own compact index. A witness alone would only say the tree holds the message.
    const parentCount = (await committedMessageCount(inserting.blockNumber - 1))!;
    const insertedCount = (await committedMessageCount(inserting.blockNumber))!;
    expect(insertedCount).toBeGreaterThan(parentCount);
    const witness = await aztecNode.getL1ToL2MessageMembershipWitness(inserting.blockNumber, msgHash);
    expect(witness).toBeDefined();

    // The prover node proves the checkpoint that holds the zero-tx block: the no-tx block-root circuit variant
    // has to pass the real prover-node orchestration, not a hand-marked proven tip.
    await waitForProvenThrough(inserting.blockNumber);
    const provenCheckpoint = (await aztecNode.getBlockData(inserting.blockNumber))!.checkpointNumber;
    expect(provenCheckpoint).toEqual(inserting.checkpointNumber);
    expect(await aztecNode.getCheckpointNumber('proven')).toBeGreaterThanOrEqual(inserting.checkpointNumber);
  });
});
