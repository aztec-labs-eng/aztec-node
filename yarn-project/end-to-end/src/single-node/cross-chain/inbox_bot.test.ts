import { Fr } from '@aztec-labs/aztec.js/fields';
import type { Logger } from '@aztec-labs/aztec.js/log';
import type { AztecNode } from '@aztec-labs/aztec.js/node';
import {
  type BotConfig,
  BotStore,
  InboxBot,
  type InboxBotWallets,
  type InboxMessageRecord,
  MAX_INBOX_MESSAGES_PER_BATCH,
  MAX_INBOX_MESSAGES_PER_BUCKET,
  generateL1ToL2MessageIntents,
  getBotDefaultConfig,
  isTerminalInboxMessageState,
  sendL1ToL2MessageBatch,
} from '@aztec-labs/bot';
import { RecordingTelemetryClient } from '@aztec-labs/bot/testing';
import { BlockNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { SecretValue } from '@aztec-labs/foundation/config';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { bufferToHex } from '@aztec-labs/foundation/string';
import { openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { getSlotAtTimestamp, getTimestampForSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { buildProposerTimetable } from '@aztec-labs/stdlib/timetable';
import { Attributes, Metrics } from '@aztec-labs/telemetry-client';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { jest } from '@jest/globals';

import {
  L1_DIRECT_WRITE_ACCOUNT_INDEX,
  PIPELINED_FEE_PADDING,
  PIPELINING_SETUP_OPTS,
} from '../../fixtures/fixtures.js';
import { getPrivateKeyFromIndex } from '../../fixtures/utils.js';
import { CrossChainMessagingTest } from './cross_chain_messaging_test.js';

// The slowest case consumes 257 messages, which takes ~2 minutes locally; 10 minutes leaves room for a loaded CI
// machine while still failing as a jest timeout rather than as a container kill at the default 20m CI budget.
jest.setTimeout(600_000);

// Integration coverage for the inbox bot (BOT_MODE=inbox): it produces atomic Multicall3 Inbox batches on its own
// clock and follows every message through to consumption on L2, checking the node's messaging API as it goes. Runs
// over CrossChainMessagingTest without the token bridge — the bot brings its own account, TestContract and L1
// client — on the pipelining sequencer, so readiness and block relations reflect production block building rather
// than automine. Each case builds its own bot over a fresh store, sharing the node, lane wallets and the contract.
describe('single-node/cross-chain/inbox_bot', () => {
  let t: CrossChainMessagingTest;
  let log: Logger;
  let aztecNode: AztecNode;
  let wallets: InboxBotWallets;
  let l1RpcUrls: string[];

  /** Every bot in this suite deploys and consumes through the same TestContract. */
  const tokenSalt = new Fr(1986);

  beforeAll(async () => {
    t = new CrossChainMessagingTest(
      'inbox_bot',
      PIPELINING_SETUP_OPTS,
      { aztecProofSubmissionEpochs: 2, aztecEpochDuration: 4 },
      {},
      { l1HarnessAccountIndex: L1_DIRECT_WRITE_ACCOUNT_INDEX, deployTokenBridge: false },
    );
    await t.setup();

    ({ logger: log, aztecNode } = t);
    l1RpcUrls = t.aztecNodeConfig.l1RpcUrls;
    const [publicWallet, privateWallet] = await Promise.all([
      EmbeddedWallet.create(aztecNode, { ephemeral: true }),
      EmbeddedWallet.create(aztecNode, { ephemeral: true }),
    ]);
    wallets = { public: publicWallet, private: privateWallet };
  }, 600_000);

  afterAll(async () => {
    await Promise.all([wallets.public.stop(), wallets.private.stop()]);
    await t.teardown();
  });

  /**
   * Builds a bot over a fresh store and an in-memory telemetry client that keeps every sample, so a test can
   * assert on the checks and failures the bot exported rather than on its internals.
   */
  const createBot = async (overrides: Partial<BotConfig>) => {
    const telemetry = new RecordingTelemetryClient();
    const store = new BotStore(await openTmpStore('inbox-bot-e2e'));
    const config: BotConfig = {
      ...getBotDefaultConfig(),
      botMode: 'inbox',
      followChain: 'PROPOSED',
      minFeePadding: PIPELINED_FEE_PADDING,
      tokenSalt,
      l1RpcUrls,
      // A dedicated L1 account: index 0 is the sequencer's publisher and index 1 the suite's harness client.
      l1PrivateKey: new SecretValue(bufferToHex(getPrivateKeyFromIndex(11)!)),
      // Long enough that the bot only produces the batches each test asks it for.
      txIntervalSeconds: 3600,
      inboxSaturationIntervalSeconds: 0,
      ...overrides,
    };
    const bot = await InboxBot.create(config, wallets, aztecNode, t.aztecNodeAdmin, store, telemetry);
    return { bot, store, telemetry };
  };

  /** Samples the bot exported for one check outcome, across every anchor policy. */
  const checks = (telemetry: RecordingTelemetryClient, check: string, result: string) =>
    telemetry.meter.sum(Metrics.BOT_INBOX_CHECK_COUNT, {
      [Attributes.BOT_INBOX_CHECK]: check,
      [Attributes.BOT_INBOX_RESULT]: result,
    });

  /** Failures the bot exported, across every bounded reason. */
  const failures = (telemetry: RecordingTelemetryClient) => telemetry.meter.sum(Metrics.BOT_INBOX_FAILURE_COUNT, {});

  /** The batch the bot reserved, once it exists. Production runs on the bot's own clock, so it is waited for. */
  const waitForBatch = (store: BotStore, timeoutSeconds = 120) =>
    retryUntil(
      async () => (await store.inbox.getActiveMessages())[0]?.batchId,
      'inbox bot reserves a batch',
      timeoutSeconds,
      0.5,
    );

  /** Waits until every message of `batchId` has reached a terminal state, and returns them. */
  const waitForBatchResolved = async (
    store: BotStore,
    batchId: string,
    timeoutSeconds: number,
  ): Promise<InboxMessageRecord[]> =>
    await retryUntil(
      async () => {
        const messages = await store.inbox.getBatchMessages(batchId);
        return messages.length > 0 && messages.every(message => isTerminalInboxMessageState(message.state))
          ? messages
          : undefined;
      },
      `inbox bot resolves every message of batch ${batchId}`,
      timeoutSeconds,
      2,
    );

  /**
   * The first slot whose checkpoint L1 obliges to consume an Inbox bucket opened at `l1Timestamp`. Mirrors the
   * rollup's `TimeLib.getInboxCutoffTimestamp`: a bucket is mandatory for slot S once it is at or before one L1 slot
   * before slot S-1 starts, which is also when the proposer for slot S opens its build frame.
   */
  const firstSlotObligedToConsume = (l1Timestamp: bigint) => {
    const inboxCutoff = (slot: SlotNumber) =>
      getTimestampForSlot(SlotNumber.add(slot, -1), t.constants) - BigInt(t.constants.ethereumSlotDuration);
    let slot = SlotNumber.add(getSlotAtTimestamp(l1Timestamp, t.constants), 1);
    while (inboxCutoff(slot) < l1Timestamp) {
      slot = SlotNumber.add(slot, 1);
    }
    return slot;
  };

  /** The cumulative Inbox message count the L2 chain has consumed through `blockNumber`. */
  const consumedThrough = async (blockNumber: BlockNumber) =>
    BigInt((await aztecNode.getBlock(blockNumber))!.header.state.l1ToL2MessageTree.nextAvailableLeafIndex);

  /**
   * Waits until a batch broadcast right away lands where the checkpoint L1 first obliges to consume it can take all
   * of it, and returns the L1 timestamp the batch will carry with the wall-clock time the window opened. A batch one
   * message over a bucket spans two buckets and a block consumes at most one bucket's worth, so that checkpoint needs
   * both of its blocks, sub-slot 0 included. Two things can cost it sub-slot 0:
   * - A late start. The proposer for slot S builds during slot S-1 and passes its sync gate at the build-frame start
   *   only if the checkpoint for slot S-2 is already on L1. Otherwise it waits for the L1 block at the frame start to
   *   be synced, which can be too late for sub-slot 0. The previous case pauses the sequencer and leaves such gaps, so
   *   the S-2 checkpoint must exist. By the time the window is checked the local sequencer has already proposed it,
   *   and it lands on L1 in the first block of slot S-2, well before the frame start.
   * - A batch its first block does not see. That block picks its messages when the build frame opens, so the batch
   *   has to be mined and synced before then. It also has to be mined after the proposer of the slot before picked
   *   the messages for its last block, or that proposer takes the first bucket on its own. Even a late proposer for
   *   S-1 picks no later than its last sub-slot's deadline less the minimum block duration, which the margin covers.
   * The next L1 block's mining time is predicted from when the latest one was first seen, so the L1 tip is polled
   * finely and a block already mined at the first poll is not used. The prediction only holds if nothing pauses L1
   * mining before that block, so blocks around an epoch boundary, where the epoch settler marks the epoch proven, are
   * passed over.
   */
  const waitForSaturationSendWindow = async () => {
    const { slotDuration, ethereumSlotDuration, epochDuration } = t.constants;
    const timetable = buildProposerTimetable(t.aztecNodeConfig, t.constants);
    const lastSubslot = timetable.getMaxBlocksPerCheckpoint() - 1;
    /** Seconds kept clear of the previous proposer's last pick and of the archiver syncing the batch in time. */
    const margin = 2;
    let latestSeen: bigint | undefined;
    return await retryUntil(
      async () => {
        const latest = await t.harnessL1Client.getBlock();
        const seenAt = t.context.dateProvider.now() / 1000;
        const isNewBlock = latestSeen !== undefined && latest.number > latestSeen;
        latestSeen = latest.number;
        if (!isNewBlock) {
          return undefined;
        }

        const slotInEpoch = getSlotAtTimestamp(latest.timestamp, t.constants) % epochDuration;
        if (slotInEpoch === 0 || slotInEpoch === epochDuration - 1) {
          return undefined;
        }

        const batchTimestamp = latest.timestamp + BigInt(ethereumSlotDuration);
        const batchMinedAt = seenAt + ethereumSlotDuration;
        const obligedSlot = firstSlotObligedToConsume(batchTimestamp);
        const previousLastPick = timetable.getBlockBuildDeadline(SlotNumber.add(obligedSlot, -1), lastSubslot - 1);
        const obligedFrameStart = timetable.getBuildFrameStart(obligedSlot);
        if (batchMinedAt < previousLastPick + margin || batchMinedAt > obligedFrameStart - margin) {
          return undefined;
        }

        // Proposed or already on L1: `getCheckpoint` serves both.
        if (!(await aztecNode.getCheckpoint({ slot: SlotNumber.add(obligedSlot, -2) }))) {
          return undefined;
        }
        log.warn(`Sending the saturation batch for obliged slot ${obligedSlot}`, {
          batchTimestamp,
          batchMinedAt,
          previousLastPick,
          obligedFrameStart,
          l1Lag: seenAt - Number(latest.timestamp),
        });
        return { batchTimestamp, openedAt: Date.now() };
      },
      'send window for a saturation batch its obliged checkpoint can consume in full',
      slotDuration * 8,
      0.1,
    );
  };

  // A normal mixed batch produced and followed end to end: both domains consume their messages, the consuming
  // transactions carry the nullifiers the bot expects, the node's index matches the Inbox event, and the batch's
  // cross-domain replay simulation is rejected once the spending nullifier is visible.
  it('produces a mixed batch and consumes it through both domains', async () => {
    const { bot, store, telemetry } = await createBot({ inboxMessagesPerBatch: 4, inboxConsumeMode: 'mixed' });

    await bot.start();
    try {
      const batchId = await waitForBatch(store);
      const messages = await waitForBatchResolved(store, batchId, 600);

      expect(messages.map(message => message.state)).toEqual(Array(4).fill('completed'));
      expect(messages.filter(message => message.mode === 'public').length).toEqual(2);
      expect(messages.filter(message => message.mode === 'private').length).toEqual(2);
      expect(messages.every(message => message.l2TxHash !== undefined)).toBe(true);

      // One atomic batch, so the Inbox assigned it contiguous indices and every message carries its bucket.
      const indices = messages.map(message => BigInt(message.globalLeafIndex!));
      expect(indices.map(index => index - indices[0])).toEqual([0n, 1n, 2n, 3n]);
      expect(messages.every(message => message.bucketSeq !== undefined)).toBe(true);

      expect(checks(telemetry, 'consumption_nullifier', 'passed')).toEqual(4);
      expect(checks(telemetry, 'index_match', 'passed')).toEqual(4);
      expect(checks(telemetry, 'event_integrity', 'passed')).toEqual(1);
      expect(checks(telemetry, 'unknown_message', 'passed')).toEqual(1);
      expect(checks(telemetry, 'readiness_witness', 'passed')).toBeGreaterThanOrEqual(2);

      // The replay probe runs on its own slower clock once every message of the batch has resolved.
      await retryUntil(
        () => Promise.resolve(checks(telemetry, 'replay_rejection', 'passed') === 1),
        'cross-domain replay simulation rejected',
        180,
        2,
      );

      expect(await store.inbox.getBatchesPendingReplayProbe()).toEqual([]);
      expect(checks(telemetry, 'consumption_nullifier', 'failed')).toEqual(0);
      expect(checks(telemetry, 'readiness_witness', 'failed')).toEqual(0);
      expect(checks(telemetry, 'replay_rejection', 'failed')).toEqual(0);
      expect(failures(telemetry)).toEqual(0);
      log.warn(`Mixed batch completed`, {
        blockRelations: messages.map(message => `${message.mode}:${message.blockRelation}`),
      });
    } finally {
      await bot.stop();
      await store.close();
    }
  });

  // A public consumption can land in the very block that inserts its message: the node simulates public calls
  // against the messages predicted for the next block, so a transaction sent as soon as the archiver has observed
  // the message is valid in the block that absorbs it. Which block wins is a scheduling race under the production
  // sequencer, so the race is removed rather than retried: block production is paused while the bot produces the
  // batch and submits its consumption, and the sequencer is resumed at a slot boundary with the transaction
  // already in the pool. The bot's steps are driven by hand here for the same reason.
  it('lands a public consumption in the block that inserts the message', async () => {
    const sequencer = t.context.aztecNodeService.getSequencer()!;
    const { bot, store, telemetry } = await createBot({ inboxMessagesPerBatch: 1, inboxConsumeMode: 'public' });

    try {
      // Nothing is built while the sequencer is paused, so the pending tip is proven first: the L1 proof window
      // would otherwise expire and prune the chain under the test.
      await t.cheatCodes.rollup.markAsProven();
      await sequencer.pause();

      await bot.produceStep();
      const batchId = await waitForBatch(store, 10);
      await retryUntil(
        async () => {
          await bot.consumeStep();
          await bot.waitForBackgroundWork();
          const [message] = await store.inbox.getBatchMessages(batchId);
          return message.state === 'sent';
        },
        'consumption transaction submitted while block production is paused',
        180,
        0.5,
      );

      await t.monitor.waitUntilNextL2Slot();
      await sequencer.start();

      const messages = await retryUntil(
        async () => {
          await bot.consumeStep();
          await bot.waitForBackgroundWork();
          const current = await store.inbox.getBatchMessages(batchId);
          return current.every(message => isTerminalInboxMessageState(message.state)) ? current : undefined;
        },
        'consumption mined',
        300,
        1,
      );

      const [message] = messages;
      log.warn(`Public consumption landed in a ${message.blockRelation} block`, {
        insertionBlockNumber: message.insertionBlockNumber,
        proposedInclusionBlockNumber: message.proposedInclusionBlockNumber,
      });
      expect(message.state).toEqual('completed');
      expect(message.blockRelation).toEqual('same_block');
      expect(failures(telemetry)).toEqual(0);
    } finally {
      // The sequencer is shared with the rest of the suite, so it is always left running. `start` is
      // idempotent, so this is safe on the path where the test already resumed it.
      await sequencer.start();
      await bot.stop();
      await store.close();
    }
  });

  // The saturation batch: 257 messages in one atomic L1 transaction, one more than a bucket holds. Every
  // expectation about its layout comes from the receipt and from the Inbox's own bucket counts at that L1 block,
  // never from an assumption that the batch started at a bucket boundary.
  it('sends a full-bucket saturation batch that rolls the bucket over and consumes every message', async () => {
    const { bot, store, telemetry } = await createBot({
      inboxConsumeMode: 'public',
      inboxSaturationIntervalSeconds: 86_400,
      l1ToL2SeedCount: MAX_INBOX_MESSAGES_PER_BATCH,
    });
    // Due immediately: `start()` keeps a persisted due time that is sooner than startup plus the interval, so the
    // first production step runs the saturation batch instead of waiting a day for it.
    await store.inbox.setSchedule({ enabled: true, nextDueAt: 0, runInFlight: false, consecutiveFailures: 0 });

    try {
      const { batchTimestamp, openedAt } = await waitForSaturationSendWindow();
      await bot.start();
      const batchId = await waitForBatch(store);
      const batch = await retryUntil(
        async () => {
          const record = await store.inbox.getBatch(batchId);
          return record?.state === 'mined' ? record : undefined;
        },
        'saturation batch mined on L1',
        180,
        1,
      );
      expect(batch.scenario).toEqual('saturation');
      expect(batch.messageCount).toEqual(MAX_INBOX_MESSAGES_PER_BATCH);
      // The batch made the L1 block the send window was chosen for. The broadcast has under an L1 slot to get there,
      // so the latency is logged to tell a slow send apart from a wrong mining prediction.
      log.warn(`Saturation batch broadcast ${batch.submittedAt! - openedAt}ms after its send window opened`, {
        plannedL1Timestamp: batchTimestamp,
        l1BlockTimestamp: batch.l1BlockTimestamp,
      });
      expect(BigInt(batch.l1BlockTimestamp!)).toEqual(batchTimestamp);

      const messages = await store.inbox.getBatchMessages(batchId);
      const indices = messages.map(message => BigInt(message.globalLeafIndex!));
      expect(indices.length).toEqual(MAX_INBOX_MESSAGES_PER_BATCH);
      expect(indices.map(index => index - indices[0])).toEqual(indices.map((_, i) => BigInt(i)));

      // The buckets the batch used, in the order it used them, and what the Inbox held in them at that L1 block.
      const buckets = [...new Set(messages.map(message => BigInt(message.bucketSeq!)))];
      const l1BlockNumber = BigInt(batch.l1BlockNumber!);
      const totals = await Promise.all(buckets.map(seq => t.inbox.getBucket(seq, { blockNumber: l1BlockNumber })));
      const inFirstBucket = messages.filter(message => BigInt(message.bucketSeq!) === buckets[0]).length;
      log.warn(`Saturation batch bucket layout`, {
        l1BlockNumber,
        inFirstBucket,
        buckets: buckets.map((seq, i) => ({
          seq,
          msgCount: totals[i].msgCount,
          totalMsgCount: totals[i].totalMsgCount,
        })),
      });

      expect(buckets.length).toEqual(2);
      expect(buckets[1]).toEqual(buckets[0] + 1n);
      // The rollover happened because the first bucket filled up, wherever inside the batch that fell.
      expect(totals[0].msgCount).toEqual(MAX_INBOX_MESSAGES_PER_BUCKET);
      expect(totals[1].msgCount).toEqual(MAX_INBOX_MESSAGES_PER_BATCH - inFirstBucket);
      expect(checks(telemetry, 'bucket_rollover', 'passed')).toEqual(1);
      expect(checks(telemetry, 'bucket_rollover', 'failed')).toEqual(0);

      const resolved = await waitForBatchResolved(store, batchId, 900);
      expect(resolved.filter(message => message.state === 'completed').length).toEqual(MAX_INBOX_MESSAGES_PER_BATCH);

      // The checkpoint L1 first obliged to consume the batch took all of it: the first bucket in the block it built
      // in sub-slot 0 and the rolled-over bucket in its final block. Had it lost sub-slot 0, its single block could
      // not have consumed both buckets, so that slot would have no checkpoint and a later one would hold the batch.
      const obligedSlot = firstSlotObligedToConsume(BigInt(batch.l1BlockTimestamp!));
      await retryUntil(
        async () => ((await aztecNode.getCheckpoint('checkpointed'))?.header.slotNumber ?? 0) >= obligedSlot,
        `checkpointed tip reaches slot ${obligedSlot}`,
        t.constants.slotDuration * 4,
        1,
      );
      const obligedCheckpoint = await aztecNode.getCheckpoint(
        { slot: obligedSlot },
        { includeBlocks: true, includeL1PublishInfo: true },
      );
      expect(obligedCheckpoint).toBeDefined();
      expect(await consumedThrough(BlockNumber(obligedCheckpoint!.startBlock - 1))).toBeLessThanOrEqual(indices[0]);
      expect(
        obligedCheckpoint!.blocks.map(block => BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex)),
      ).toEqual(totals.map(bucket => bucket.totalMsgCount));

      expect(checks(telemetry, 'consumption_nullifier', 'failed')).toEqual(0);
      expect(failures(telemetry)).toEqual(0);
      log.warn(`Saturation batch consumed`, {
        sameBlock: resolved.filter(message => message.blockRelation === 'same_block').length,
        laterBlock: resolved.filter(message => message.blockRelation === 'later_block').length,
        unknown: resolved.filter(message => message.blockRelation === 'unknown').length,
      });

      // A run only closes once its replay probe has a verdict, and the probe starts on the consumption clock only
      // after every message has resolved, so it is still outstanding at this point.
      await retryUntil(
        async () => (await store.inbox.getBatch(batchId))!.replayProbedAt !== undefined,
        'saturation batch replay probe resolved',
        180,
        2,
      );

      // The run is closed out on the production clock, which this suite has set to an hour; drive one more step
      // rather than wait for it. The same step also produces an ordinary batch, which the test leaves behind.
      await bot.produceStep();
      const schedule = (await store.inbox.getSchedule())!;
      expect(schedule.runInFlight).toBe(false);
      // Every message consumed and every check passed, which is what a successful run means.
      expect(schedule.lastSuccessAt).toBeDefined();
      expect((await store.inbox.getBatch(batchId))!.failedChecks).toEqual([]);
      expect(
        telemetry.meter.sum(Metrics.BOT_INBOX_SATURATION_RUN_COUNT, { [Attributes.BOT_INBOX_RESULT]: 'success' }),
      ).toEqual(1);
    } finally {
      await bot.stop();
      await store.close();
    }
  });

  // L1 gas for the batch sizes the bot sends, measured against this implementation: one atomic Multicall3
  // `aggregate3` of `sendL2Message` calls with gas taken from estimation. The numbers are recorded in
  // bot/README.md; the assertions pin the shape only, since absolute gas moves with the Inbox implementation.
  it('measures L1 gas for 4, 256 and 257 message batches', async () => {
    const inboxAddress = EthAddress.fromString(t.deployL1ContractsValues.l1ContractAddresses.inboxAddress.toString());
    const rollupVersion = BigInt(await t.rollup.getVersion());
    const measured: { count: number; gasUsed: bigint; gasPerMessage: bigint; buckets: number }[] = [];

    for (const count of [4, MAX_INBOX_MESSAGES_PER_BUCKET, MAX_INBOX_MESSAGES_PER_BATCH]) {
      const intents = await generateL1ToL2MessageIntents(count);
      const receipt = await sendL1ToL2MessageBatch({
        l1Client: t.harnessL1Client,
        inboxAddress,
        recipient: t.ownerAddress,
        rollupVersion,
        intents,
        log,
      });
      expect(receipt.status).toEqual('success');
      expect(receipt.messages.length).toEqual(count);
      measured.push({
        count,
        gasUsed: receipt.gasUsed,
        gasPerMessage: receipt.gasUsed / BigInt(count),
        buckets: new Set(receipt.messages.map(message => message.bucketSeq)).size,
      });
    }

    log.warn(`Inbox batch L1 gas`, {
      measurements: measured.map(entry => ({
        messages: entry.count,
        gasUsed: entry.gasUsed.toString(),
        gasPerMessage: entry.gasPerMessage.toString(),
        buckets: entry.buckets,
      })),
    });

    const [four, full, rollover] = measured;
    expect(four.gasUsed).toBeGreaterThan(0n);
    expect(full.gasUsed).toBeGreaterThan(four.gasUsed);
    // The 257th message opens a bucket, so it costs more than any of the 256 that fit in one.
    expect(rollover.gasUsed).toBeGreaterThan(full.gasUsed);
    expect(full.buckets).toEqual(1);
    expect(rollover.buckets).toEqual(2);
    // Batching amortizes the transaction's fixed cost over its messages.
    expect(full.gasPerMessage).toBeLessThan(four.gasPerMessage);
  });
});
