import { InboxAbi } from '@aztec-foundation/l1-artifacts';

import type { Archiver } from '@aztec-labs/archiver';
import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { generateClaimSecret } from '@aztec-labs/aztec.js/ethereum';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { createLogger } from '@aztec-labs/aztec.js/log';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { InboxContract, MULTI_CALL_3_ADDRESS, RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { times, timesAsync } from '@aztec-labs/foundation/collection';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { executeTimeout } from '@aztec-labs/foundation/timer';
import { TestContract } from '@aztec-labs/noir-test-contracts.js/Test';
import type { SequencerEvents } from '@aztec-labs/sequencer-client';
import { WANT_TO_SLASH_EVENT, type WantToSlashArgs } from '@aztec-labs/slasher';
import {
  type BlockHash,
  type L2Block,
  L2BlockSourceEvents,
  type L2PruneUncheckpointedEvent,
  type L2PruneUnprovenEvent,
} from '@aztec-labs/stdlib/block';
import { computeQuorum, getSlotAtTimestamp, getTimestampForSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { OffenseType } from '@aztec-labs/stdlib/slashing';
import type { BlockProposalObservers } from '@aztec-labs/validator-client';
import { type Hex, encodeFunctionData, parseEventLogs } from 'viem';

import {
  type CheckpointPhasePredicate,
  CheckpointProposalJobTestGate,
} from '../../fixtures/checkpoint_proposal_job_test_gate.js';
import { sendL1ToL2Message } from '../../fixtures/l1_to_l2_messaging.js';
import { waitForCanonicalMessageSyncpoint } from '../../fixtures/message_syncpoint.js';
import { waitForBlockNumber, waitForTxs } from '../../fixtures/wait_helpers.js';
import { proveAndSendTxs } from '../../test-wallet/utils.js';
import {
  type BlockProductionWithProverFixture,
  NODE_COUNT,
  type TrackedSequencerEvent,
  jest,
  setupBlockProductionWithProver,
  waitForProvenCheckpoint,
} from './setup.js';

const TX_COUNT = 10;

/** One collection per validator node, indexed the same way the fixture indexes its nodes. */
type PerNode<T> = T[][];

/** What the validator's first Inbox metadata comparison reports, as the observers hand it over. */
type InboxMetadataCheck = Parameters<NonNullable<BlockProposalObservers['onFirstInboxMetadataCheck']>>[0];

/** What a validator's completed block-proposal decision reports. */
type BlockDecision = Parameters<NonNullable<BlockProposalObservers['onBlockProposalDecision']>>[0];

/** A streaming-Inbox checkpoint abort, tagged with the node whose sequencer reported it. */
type ObservedAbort = Parameters<SequencerEvents['checkpoint-build-aborted']>[0] & { sequencerIndex: number };

/** The slot a tracked sequencer failure is about, when it has one. */
const failedSlot = (event: TrackedSequencerEvent): SlotNumber | undefined => ('slot' in event ? event.slot : undefined);

/**
 * L1 blocks the reorg phase reserves before it opens its window: the message send plus the hold. The prover's next
 * submission is deferred past it before anything is sent, and the window is asserted to have stayed inside it.
 */
const PROVER_DEFERRAL_L1_BLOCKS = 24;

// Cross-chain payloads survive multi-block production: L2→L1 message effects are present across the
// produced blocks, and L1→L2 messages become ready after inbox lag and their consume txs mine. Both
// run the shared MBPS pipelining context (4 validators + prover) from setup.ts.
describe('multi-node/block-production/cross_chain_messages', () => {
  let fixture: BlockProductionWithProverFixture;
  /** One gate per validator node: only the node that happens to be proposing matches, and the rest are released. */
  let gates: CheckpointProposalJobTestGate[] = [];

  afterEach(async () => {
    gates.forEach(gate => gate.release());
    gates = [];
    jest.restoreAllMocks();
    await fixture?.test?.teardown();
  });

  // Deploys a cross-chain TestContract, pre-proves TX_COUNT L2→L1 message txs, sends them all, waits
  // for all to be mined, then asserts the total L2→L1 message count across all blocks ≥ TX_COUNT,
  // a MBPS checkpoint exists, and that checkpoint is proven.
  it('builds multiple blocks per slot with L2 to L1 messages', async () => {
    fixture = await setupBlockProductionWithProver({ syncChainTip: 'proposed', minTxsPerBlock: 1, maxTxsPerBlock: 2 });
    const { test, context, logger, archiver, nodes, wallet, from } = fixture;

    // Start sequencers first, then deploy cross-chain contract (needs running sequencer to mine).
    await test.startSequencers(nodes);
    logger.warn(`Started all sequencers`);

    logger.warn(`Deploying cross-chain test contract`);
    const { contract: crossChainContract } = await TestContract.deploy(wallet).send({ from });
    logger.warn(`Cross-chain test contract deployed at ${crossChainContract.address}`);

    // Pre-prove and send all L2→L1 message transactions at once
    const l2ToL1Recipient = EthAddress.fromString(context.deployL1ContractsValues.l1Client.account.address);
    logger.warn(`Pre-proving ${TX_COUNT} L2→L1 message transactions`);
    const txHashes = await proveAndSendTxs(
      wallet,
      TX_COUNT,
      () => crossChainContract.methods.create_l2_to_l1_message_arbitrary_recipient_public(Fr.random(), l2ToL1Recipient),
      { from },
    );
    logger.warn(`Sent ${txHashes.length} L2→L1 message transactions`);

    // Wait until all txs are mined
    const timeout = test.L2_SLOT_DURATION_IN_S * 5;
    const receipts = await waitForTxs(context.aztecNode, txHashes, { timeout });
    logger.warn(`All L2→L1 message txs have been mined`);

    // wait for the other node to synch (nodes[0]'s block source is `archiver`)
    const maxBlockNumber = Math.max(...receipts.map(r => r.blockNumber!));
    await waitForBlockNumber(nodes[0], maxBlockNumber, {
      tag: 'checkpointed',
      timeout: test.L2_SLOT_DURATION_IN_S * 3,
      interval: 0.1,
    });

    // Mirror the sibling MBPS tests: we may lose one sub-slot to pipelined overhead, so accept >= 2
    // blocks per checkpoint rather than the legacy 3-block expectation.
    const multiBlockCheckpoint = await fixture.test.assertMultipleBlocksPerSlot(2, {
      wait: true,
      archiver: fixture.archiver,
    });

    // Verify L2→L1 messages are in the blocks
    const checkpoints = await archiver.getCheckpoints({ from: CheckpointNumber(1), limit: 50 });
    const allBlocks = checkpoints.flatMap(pc => pc.checkpoint.blocks);
    const allL2ToL1Messages = allBlocks.flatMap(block => block.body.txEffects.flatMap(txEffect => txEffect.l2ToL1Msgs));
    logger.warn(`Found ${allL2ToL1Messages.length} L2→L1 message(s) across all blocks`, { allL2ToL1Messages });
    expect(allL2ToL1Messages.length).toBeGreaterThanOrEqual(TX_COUNT);
    await waitForProvenCheckpoint(fixture, multiBlockCheckpoint);
  });

  // Seeds L1→L2 messages, sends filler txs to advance the chain so messages become ready, then
  // pre-proves and sends consume txs. Verifies all consume txs are mined, a MBPS checkpoint exists,
  // and that checkpoint is proven.
  it('builds multiple blocks per slot with L1 to L2 messages', async () => {
    // An L1→L2 message becomes ready once some block has inserted it into the message tree: under the streaming
    // Inbox a block consumes whatever prefix its proposer's archiver has observed, so readiness needs blocks to
    // keep being built rather than a fixed number of checkpoints to elapse. With skipInitialSequencer the chain
    // won't move on its own, and a one-shot burst of filler txs lands within a single checkpoint — so let the
    // sequencer keep building (empty) blocks each slot to drive the chain forward until the messages are ready.
    // One gate and one observer set per validator: the reorg phase below has to hold exactly the node that is
    // proposing and read the mismatch off a different, named one, so the observations cannot be shared.
    gates = times(NODE_COUNT, i => new CheckpointProposalJobTestGate(createLogger(`e2e:mbps:gate-${i}`), 300_000));
    const firstChecks: PerNode<InboxMetadataCheck> = times(NODE_COUNT, () => []);
    const decisions: PerNode<BlockDecision> = times(NODE_COUNT, () => []);

    fixture = await setupBlockProductionWithProver({
      syncChainTip: 'proposed',
      minTxsPerBlock: 0,
      maxTxsPerBlock: 1,
      buildCheckpointIfEmpty: true,
      // The reorg phase below names one non-proposer validator and requires its signature on the replacement
      // checkpoint. The profile's default picks 3 of the 4 registered validators, which would leave that choice to
      // chance; with every node eligible the named one can always attest. Quorum is 3 either way.
      aztecTargetCommitteeSize: NODE_COUNT,
      testDeps: index => ({
        checkpointProposalJobTestHooks: gates[index].hooks,
        blockProposalObservers: {
          onFirstInboxMetadataCheck: event => firstChecks[index].push(event),
          onBlockProposalDecision: event => decisions[index].push(event),
        },
      }),
    });
    const { test, context, logger, nodes, contract, wallet, from, failEvents } = fixture;

    // Start sequencers first, then deploy cross-chain contract (needs running sequencer to mine).
    await test.startSequencers(nodes);
    logger.warn(`Started all sequencers`);

    logger.warn(`Deploying cross-chain test contract`);
    const { contract: crossChainContract } = await TestContract.deploy(wallet).send({ from });
    logger.warn(`Cross-chain test contract deployed at ${crossChainContract.address}`);

    const L1_TO_L2_COUNT = 4;
    const FILLER_TX_COUNT = 5; // Enough txs to advance the chain so messages become ready

    // Seed all L1→L2 messages at the beginning
    logger.warn(`Seeding ${L1_TO_L2_COUNT} L1→L2 messages`);
    const l1ToL2Messages = await timesAsync(L1_TO_L2_COUNT, async i => {
      const [secret, secretHash] = await generateClaimSecret();
      const content = Fr.random();
      const message = { recipient: crossChainContract.address, content, secretHash };

      const { msgHash, globalLeafIndex } = await sendL1ToL2Message(message, {
        l1Client: context.deployL1ContractsValues.l1Client,
        l1ContractAddresses: context.deployL1ContractsValues.l1ContractAddresses,
      });
      logger.warn(`L1→L2 message ${i + 1} sent with hash ${msgHash} and index ${globalLeafIndex}`);

      return { content, secret, msgHash, globalLeafIndex };
    });
    logger.warn(`Seeded ${l1ToL2Messages.length} L1→L2 messages`);

    // Pre-prove and send all filler txs at once (using unique nullifiers to avoid conflicts)
    logger.warn(`Pre-proving ${FILLER_TX_COUNT} filler txs to advance the chain`);
    const fillerTxHashes = await proveAndSendTxs(
      wallet,
      FILLER_TX_COUNT,
      i => contract.methods.emit_nullifier(new Fr(1000 + i)),
      { from },
    );
    logger.warn(`Sent ${fillerTxHashes.length} filler txs`);

    // Wait for filler txs to be mined first - this ensures the chain has advanced enough for messages to be ready
    const timeout = test.L2_SLOT_DURATION_IN_S * 5;
    await executeTimeout(() => waitForTxs(context.aztecNode, fillerTxHashes, { timeout }), timeout * 1000);
    logger.warn(`All filler txs have been mined`);

    // Wait for all messages to be ready in parallel (chain has advanced, messages should be available)
    const ethAccount = EthAddress.fromString(context.deployL1ContractsValues.l1Client.account.address);
    await Promise.all(
      l1ToL2Messages.map(async ({ msgHash }, i) => {
        logger.warn(`Waiting for L1→L2 message ${i + 1} to be ready`);
        await retryUntil(
          () => isL1ToL2MessageReady(context.aztecNode, msgHash),
          `L1→L2 message ${i + 1} ready`,
          test.L2_SLOT_DURATION_IN_S * 5,
        );
        logger.warn(`L1→L2 message ${i + 1} is ready`);
      }),
    );
    logger.warn(`All ${l1ToL2Messages.length} L1→L2 messages are ready`);

    // Pre-prove and send all consume transactions at once (proving up front avoids nonce conflicts)
    logger.warn(`Pre-proving ${l1ToL2Messages.length} consume transactions`);
    const consumeTxHashes = await proveAndSendTxs(
      wallet,
      l1ToL2Messages.length,
      i => {
        const { content, secret, globalLeafIndex } = l1ToL2Messages[i];
        return crossChainContract.methods.consume_message_from_arbitrary_sender_public(
          content,
          secret,
          ethAccount,
          globalLeafIndex,
        );
      },
      { from },
    );
    logger.warn(`Sent ${consumeTxHashes.length} consume transactions`);

    // Wait for all consume txs to be mined
    await waitForTxs(context.aztecNode, consumeTxHashes, { timeout });
    logger.warn(`All ${consumeTxHashes.length} L1→L2 messages consumed`);

    await fixture.test.assertMultipleBlocksPerSlot(2, { wait: true, archiver: fixture.archiver });

    // Content-changing L1 reorg while a checkpoint is in flight. A changed message prefix is where multi-node
    // behaviour adds information a single node cannot: the proposer and the validators observe the reorg at
    // different moments, a validator must read its own prefix mismatch as local-view state rather than proposer
    // misconduct, and the committee has to recover quorum on a replacement built from the canonical prefix. The
    // stale block is signed and stored before L1 changes and gossiped after, so the validator's mismatch is against
    // a parent it still holds rather than a block it never received.
    const { l1Client, l1ContractAddresses } = context.deployL1ContractsValues;
    const inbox = new InboxContract(l1Client, l1ContractAddresses.inboxAddress.toString());
    const rollup = new RollupContract(l1Client, l1ContractAddresses.rollupAddress.toString());
    const archivers = nodes.map(node => node.getBlockSource() as Archiver);
    const inboxAddress = l1ContractAddresses.inboxAddress.toString();

    /** The `sendL2Message` call for one message, so a reorg can insert it without a live sender. */
    const prepareMessage = async () => {
      const recipient = await AztecAddress.random();
      const content = Fr.random();
      const secretHash = Fr.random();
      const version = BigInt(await rollup.getVersion());
      return {
        recipient,
        content,
        secretHash,
        call: {
          to: inboxAddress as Hex,
          from: messageSender.account.address,
          input: encodeFunctionData({
            abi: InboxAbi,
            functionName: 'sendL2Message',
            args: [{ actor: recipient.toString(), version }, content.toString(), secretHash.toString()],
          }),
          // Estimated against the pre-reorg chain the bucket is warm; inserted after the rollback it is opened cold
          // and costs far more, so an estimated limit runs out of gas and the message is never emitted.
          gas: 1_000_000n,
        },
      };
    };

    /** The single `MessageSent` event the Inbox emitted in `l1BlockNumber`: the real leaf hash and compact index. */
    const messageSentIn = async (l1BlockNumber: bigint) => {
      const logs = await l1Client.getLogs({
        address: inboxAddress as Hex,
        fromBlock: l1BlockNumber,
        toBlock: l1BlockNumber,
      });
      const [event, ...rest] = parseEventLogs({ abi: InboxAbi, eventName: 'MessageSent', logs });
      if (event === undefined || rest.length > 0) {
        throw new Error(`Expected exactly one MessageSent event in L1 block ${l1BlockNumber}, got ${rest.length + 1}`);
      }
      return { msgHash: Fr.fromHexString(event.args.hash), index: event.args.message.index };
    };

    /** The committee that may attest at `slot`, lower-cased for address comparison. */
    const committeeAtSlot = async (slot: SlotNumber) => {
      const committee = await rollup.getCommitteeAt(getTimestampForSlot(slot, test.constants));
      return (committee ?? []).map(address => address.toString().toLowerCase());
    };

    // A dedicated L1 sender, so the messages this phase sends cannot collide on nonce with the publisher or the
    // prover, whose transactions are the ones the reorg must not replace away.
    const { client: messageSender } = await test.createL1Client();

    // Production is stopped between checkpoints before anything is sent: pausing drains the in-flight checkpoint and
    // its pending L1 submission, so the window the reorg replaces cannot contain a publication, and no proposer can
    // consume the message before the gates exist. The prover's next submission is deferred past the window for the
    // same reason — a proof inside it would be replaced away — and restored in the `finally`.
    await Promise.all(nodes.map(node => node.getSequencer()!.pause()));
    const publishedParent = await test.monitor.run(true);
    const l1BlockBeforeReorgWindow = BigInt(publishedParent.l1BlockNumber);
    const parentCheckpointNumber = publishedParent.checkpointNumber;
    test.proverDelayer.pauseNextTxUntilBlock(
      l1BlockBeforeReorgWindow + BigInt(PROVER_DEFERRAL_L1_BLOCKS),
      test.L1_BLOCK_TIME_IN_S * (PROVER_DEFERRAL_L1_BLOCKS + 8),
    );

    const replacedIndex = (await inbox.getState()).totalMessagesInserted;
    const original = await prepareMessage();
    const replacement = await prepareMessage();

    const prunes: PerNode<L2Block> = times(NODE_COUNT, () => []);
    const slashRequests: PerNode<WantToSlashArgs> = times(NODE_COUNT, () => []);
    const aborts: ObservedAbort[] = [];
    const cleanups: (() => void)[] = [];

    // Armed before production resumes and before the message exists, so nothing can cross the replaced index
    // before there is a gate to hold it. Only the node that happens to be proposing matches.
    const crossesReplacement: CheckpointPhasePredicate = event =>
      event.phase === 'block-ready-to-broadcast' && event.isStandalone && event.consumedMessageCount > replacedIndex;
    const armings = gates.map(gate => gate.arm(crossesReplacement));
    // The three non-proposers never match and are released at the end; their watchdogs must not surface as
    // unhandled rejections in the meantime.
    armings.forEach(arming => {
      arming.matched.catch(() => {});
      arming.completed.catch(() => {});
      arming.failed.catch(() => {});
    });

    try {
      const originalSend = await sendL1ToL2Message(
        { recipient: original.recipient, content: original.content, secretHash: original.secretHash },
        { l1Client: messageSender, l1ContractAddresses },
      );
      expect(originalSend.globalLeafIndex.toBigInt()).toEqual(replacedIndex);
      logger.warn(`Sent the message the reorg will replace`, {
        msgHash: originalSend.msgHash.toString(),
        index: replacedIndex,
        l1BlockNumber: originalSend.txReceipt.blockNumber,
      });

      // Resume at the start of a build frame. Resuming late leaves one sub-slot, so the block that first crosses
      // the replaced index is the checkpoint's final block rather than a standalone one, and the gate never sees it.
      const resumeAt = getSlotAtTimestamp(BigInt(await context.cheatCodes.eth.lastBlockTimestamp()), test.constants);
      await test.waitForBuildWindowForSlot(SlotNumber(Number(resumeAt) + 2));
      await test.startSequencers(nodes);

      const held = await Promise.race(armings.map(arming => arming.matched));
      const proposerIndex = gates.findIndex(gate => gate.heldEvent?.blockHash.equals(held.blockHash));
      expect(proposerIndex).toBeGreaterThanOrEqual(0);
      // One arming holds one block, so the gates that did not match are released immediately rather than left to
      // hold a later, unrelated checkpoint.
      gates.forEach((gate, index) => index !== proposerIndex && gate.release());

      const holder = gates[proposerIndex];
      const holderArming = armings[proposerIndex];
      const heldSlot: SlotNumber = held.slot;
      const heldBlockHash: BlockHash = held.blockHash;
      const heldProposer = fixture.validators[proposerIndex].attester;
      // The named validator is a committee member that is not the proposer, so its prefix mismatch is a peer's
      // verdict on someone else's block rather than a node disagreeing with itself. Membership is read from the
      // rollup for the held slot rather than assumed from the node index: a validator outside the committee could
      // not attest to the replacement, and its missing signature would be a setup artefact, not a protocol result.
      const committeeAtHeldSlot = await committeeAtSlot(heldSlot);
      const eligible = times(NODE_COUNT, i => i).filter(
        index =>
          index !== proposerIndex &&
          committeeAtHeldSlot.includes(fixture.validators[index].attester.toString().toLowerCase()),
      );
      expect(eligible.length).toBeGreaterThan(0);
      const validatorIndex = eligible[0];
      const namedValidator = fixture.validators[validatorIndex].attester;
      logger.warn(`Holding block ${held.blockNumber} of checkpoint ${held.checkpointNumber} at slot ${heldSlot}`, {
        proposerIndex,
        validatorIndex,
        namedValidator: namedValidator.toString(),
        consumedMessageCount: held.consumedMessageCount,
      });

      const replacementAnchor = await Promise.race([
        (async () => {
          const ctx = holder.heldContext()!;

          // The held block crosses the replacement index and its parent does not, which is what makes the stale
          // block's prefix the one the reorg invalidates.
          const parentNumber = BlockNumber(held.blockNumber - 1);
          const parentOnProposer = (await archivers[proposerIndex].getBlockData({ number: parentNumber }))!;
          const parentCount = BigInt(parentOnProposer.header.state.l1ToL2MessageTree.nextAvailableLeafIndex);
          expect(parentCount).toBeLessThanOrEqual(replacedIndex);
          expect(held.consumedMessageCount).toBeGreaterThan(replacedIndex);

          // The named validator can re-execute against the stale block's parent, so its rejection below is about
          // the Inbox prefix and not about a parent it never had.
          const parentOnValidator = await retryUntil(
            () => archivers[validatorIndex].getBlockData({ number: parentNumber }),
            `validator ${validatorIndex} holds the stale block's parent`,
            test.L2_SLOT_DURATION_IN_S,
            0.2,
          );
          expect(parentOnValidator.archive.root.toString()).toEqual(parentOnProposer.archive.root.toString());

          // Every observer is attached before L1 changes and before the stale block is gossiped, so nothing the
          // release causes can happen unobserved.
          nodes.forEach((node, index) => {
            const onPruneUnproven = (args: L2PruneUnprovenEvent) => prunes[index].push(...args.blocks);
            const onPruneUncheckpointed = (args: L2PruneUncheckpointedEvent) => prunes[index].push(...args.blocks);
            archivers[index].events.on(L2BlockSourceEvents.L2PruneUnproven, onPruneUnproven);
            archivers[index].events.on(L2BlockSourceEvents.L2PruneUncheckpointed, onPruneUncheckpointed);
            cleanups.push(() => {
              archivers[index].events.off(L2BlockSourceEvents.L2PruneUnproven, onPruneUnproven);
              archivers[index].events.off(L2BlockSourceEvents.L2PruneUncheckpointed, onPruneUncheckpointed);
            });

            const validatorClient = node.getValidatorClient()!;
            const onWantToSlash = (args: WantToSlashArgs[]) => slashRequests[index].push(...args);
            validatorClient.on(WANT_TO_SLASH_EVENT, onWantToSlash);
            cleanups.push(() => validatorClient.off(WANT_TO_SLASH_EVENT, onWantToSlash));

            const sequencer = node.getSequencer()!.getSequencer();
            const onAbort = (args: Parameters<SequencerEvents['checkpoint-build-aborted']>[0]) =>
              aborts.push({ ...args, sequencerIndex: index });
            sequencer.on('checkpoint-build-aborted', onAbort);
            cleanups.push(() => sequencer.off('checkpoint-build-aborted', onAbort));
          });

          // The reorg window: from the L1 block carrying the replaced message to the head, strictly above the
          // parent checkpoint's publication. Publications and proofs both go through the Multicall3 forwarder, so
          // the scan looks for that as well as for direct rollup calls — it confirms the controls above held,
          // rather than standing in for them.
          const head = BigInt((await test.monitor.run(true)).l1BlockNumber);
          const reorgFrom = originalSend.txReceipt.blockNumber;
          expect(reorgFrom).toBeGreaterThan(l1BlockBeforeReorgWindow);
          expect(head - l1BlockBeforeReorgWindow).toBeLessThan(BigInt(PROVER_DEFERRAL_L1_BLOCKS));
          const rollupSenders = [l1ContractAddresses.rollupAddress.toString(), MULTI_CALL_3_ADDRESS].map(address =>
            address.toLowerCase(),
          );
          for (let n = reorgFrom; n <= head; n++) {
            const block = await l1Client.getBlock({ blockNumber: n, includeTransactions: true });
            expect(block.transactions.filter(tx => rollupSenders.includes(tx.to?.toLowerCase() ?? ''))).toHaveLength(0);
          }

          // The suffix is swapped atomically for one carrying a different message at the same index: same count,
          // changed leaf and rolling hash. `anvil_reorg` re-mines the whole depth, so the height is preserved;
          // mining is paused across the swap so the comparisons read a chain that is not moving underneath them.
          const anchorBefore = await l1Client.getBlock({ blockNumber: reorgFrom });
          const headBefore = await l1Client.getBlock({ blockNumber: head });
          const stateBefore = await inbox.getState();
          ctx.assertStillHeld('replace the L1 suffix');
          await context.cheatCodes.eth.execWithPausedAnvil(async () => {
            await context.cheatCodes.eth.reorgWithReplacement(Number(head - reorgFrom + 1n), [[replacement.call]]);
            const [anchorAfter, headAfter] = await Promise.all([
              l1Client.getBlock({ blockNumber: reorgFrom }),
              l1Client.getBlock({ blockNumber: head }),
            ]);
            expect(headAfter.number).toEqual(headBefore.number);
            expect(anchorAfter.hash).not.toEqual(anchorBefore.hash);
          });

          // The replacement's own leaf hash, read from the event it emitted rather than derived from its payload.
          const inserted = await messageSentIn(reorgFrom);
          expect(inserted.index).toEqual(replacedIndex);
          expect(inserted.msgHash.toString()).not.toEqual(originalSend.msgHash.toString());

          const stateAfter = await retryUntil(
            async () => {
              const state = await inbox.getState();
              return state.totalMessagesInserted === stateBefore.totalMessagesInserted ? state : undefined;
            },
            'Inbox holds the replacement message at the same count',
            test.L1_BLOCK_TIME_IN_S * 8,
            0.2,
          );
          // The premise: the message count is unchanged and the content is not.
          expect(stateAfter.totalMessagesInserted).toEqual(stateBefore.totalMessagesInserted);
          expect(stateAfter.rollingHash.toString()).not.toEqual(stateBefore.rollingHash.toString());

          // Both the proposer and the named validator have re-read the replaced suffix and certified their message
          // logs against the canonical chain, so the mismatch below is a real disagreement about content.
          for (const index of [proposerIndex, validatorIndex]) {
            ctx.assertStillHeld(`wait for node ${index} to reconcile`);
            await waitForCanonicalMessageSyncpoint(
              archivers[index],
              {
                getCanonicalBlockHash: (l1BlockNumber: bigint) =>
                  l1Client.getBlock({ blockNumber: l1BlockNumber }).then(
                    block => block.hash ?? undefined,
                    () => undefined,
                  ),
              },
              {
                atLeastL1BlockNumber: head,
                what: `node ${index} certifies its message log against the replacement chain`,
                timeoutSeconds: test.L1_BLOCK_TIME_IN_S * 12,
                logger,
              },
            );
          }

          // The proposer's own held block is gone with the prefix it consumed; the validator keeps the parent.
          await retryUntil(
            async () => (await archivers[proposerIndex].getBlockData({ number: held.blockNumber })) === undefined,
            'the proposer prunes the block built on the replaced prefix',
            test.L2_SLOT_DURATION_IN_S * 2,
            0.5,
          );
          expect(prunes[proposerIndex].map(block => block.number)).toContain(Number(held.blockNumber));
          expect(
            (await archivers[validatorIndex].getBlockData({ number: parentNumber }))!.archive.root.toString(),
          ).toEqual(parentOnProposer.archive.root.toString());

          // The release has to land inside the window peers accept a proposal in, and leave the proposer a real
          // next sub-slot: both are asked of the job's own schedule at this instant, not of the event's snapshot.
          const ingressBudgetMs = ctx.remainingIngressBudgetMs();
          logger.warn(`Releasing the stale block`, {
            ingressBudgetMs,
            holdBudgetMs: ctx.remainingHoldBudgetMs(),
            nextSubslot: ctx.nextSubslot().index,
          });
          expect(ingressBudgetMs).toBeGreaterThan(0);
          expect(ctx.canStartAnotherBlock()).toBe(true);
          ctx.assertStillHeld('release the stale block');
          return { reorgFrom, head, replacementMsgHash: inserted.msgHash };
        })(),
        holderArming.failed,
      ]);
      logger.warn(`Replaced the L1 suffix`, {
        reorgFrom: replacementAnchor.reorgFrom,
        head: replacementAnchor.head,
        replacementMsgHash: replacementAnchor.replacementMsgHash.toString(),
      });
      const replacementMsgHash = replacementAnchor.replacementMsgHash;

      // Releasing gossips the already-signed stale block: its parent is available, and its prefix no longer is.
      // The completion is awaited rather than swallowed, so a watchdog that fired mid-hold still fails here.
      holder.release();
      await holderArming.completed;

      // The named validator's first Inbox metadata comparison for this exact block is the mismatch. The final
      // decision alone could not show it: the metadata helper retries until its deadline.
      const firstMismatch = await retryUntil(
        () =>
          Promise.resolve(
            firstChecks[validatorIndex].find(check => check.blockHash.equals(heldBlockHash) && check.slot === heldSlot),
          ),
        `validator ${validatorIndex} compares the stale block's Inbox prefix`,
        test.L2_SLOT_DURATION_IN_S * 2,
        0.2,
      );
      expect(firstMismatch.accepted).toBe(false);
      expect(firstMismatch.reason).toEqual('inbox_prefix_mismatch');
      expect(firstMismatch.proposer.toString()).toEqual(heldProposer.toString());

      // And its completed decision, once the bounded retries are spent, is a non-punitive rejection of the same
      // block by the same proposer.
      const finalDecision = await retryUntil(
        () =>
          Promise.resolve(
            decisions[validatorIndex].find(decision => decision.blockHash.equals(heldBlockHash) && !decision.accepted),
          ),
        `validator ${validatorIndex} finishes rejecting the stale block`,
        test.L2_SLOT_DURATION_IN_S * 3,
        0.2,
      );
      expect(finalDecision.reason).toEqual('inbox_prefix_mismatch');
      expect(finalDecision.slashable).toBe(false);
      expect(finalDecision.slot).toEqual(heldSlot);
      expect(finalDecision.proposer.toString()).toEqual(heldProposer.toString());
      logger.warn(`Named validator rejected the stale block non-punitively`, {
        namedValidator: namedValidator.toString(),
        reason: finalDecision.reason,
      });

      // The proposer continues from a stale checkpoint cursor against its reconciled message source and gives up
      // the slot, reporting the reorg rather than a generic timeout.
      const abort = await retryUntil(
        () => Promise.resolve(aborts.find(event => event.slot === heldSlot)),
        `the proposer abandons slot ${heldSlot}`,
        test.L2_SLOT_DURATION_IN_S * 3,
        0.2,
      );
      expect(abort.reason).toEqual('inbox_prefix_reorged');
      expect(abort.sequencerIndex).toEqual(proposerIndex);

      // The replacement reaches L2 at the index the removed message used to hold, and the removed one is gone.
      await retryUntil(
        async () => (await context.aztecNode.getL1ToL2MessageIndex(replacementMsgHash)) !== undefined,
        'the replacement message reaches L2',
        test.L2_SLOT_DURATION_IN_S * 4,
        0.5,
      );
      expect(await context.aztecNode.getL1ToL2MessageIndex(replacementMsgHash)).toEqual(replacedIndex);
      expect(await context.aztecNode.getL1ToL2MessageIndex(originalSend.msgHash)).toBeUndefined();

      // The replacement checkpoint is the first published one past the parent whose blocks actually insert the
      // replacement. Picked by that property rather than by "some multi-block checkpoint", which could select an
      // older happy-path one.
      const published = await retryUntil(
        async () => {
          const candidates = await fixture.archiver.getCheckpoints({
            from: CheckpointNumber(parentCheckpointNumber + 1),
            limit: 20,
          });
          return candidates.find(candidate =>
            candidate.checkpoint.blocks.some(
              block => BigInt(block.header.state.l1ToL2MessageTree.nextAvailableLeafIndex) > replacedIndex,
            ),
          );
        },
        `a checkpoint past ${parentCheckpointNumber} publishes the replacement message`,
        test.L2_SLOT_DURATION_IN_S * 6,
        0.5,
      );
      const replacementCheckpoint = published.checkpoint.number;
      const replacementSlot = published.checkpoint.header.slotNumber;
      expect(replacementSlot).not.toEqual(heldSlot);

      // Nothing was published for the abandoned slot, checked across every checkpoint from the parent onwards.
      const sinceParent = await fixture.archiver.getCheckpoints({
        from: CheckpointNumber(parentCheckpointNumber + 1),
        limit: 20,
      });
      expect(sinceParent.map(candidate => candidate.checkpoint.header.slotNumber)).not.toContain(heldSlot);

      // Quorum recovered, and the named validator's signature over this exact archive recovers to its address.
      // Address metadata on the published attestation says who was asked, not who signed.
      const attestations = await retryUntil(
        async () => {
          const forSlot = await nodes[validatorIndex].getP2P().getCheckpointAttestationsForSlot(replacementSlot);
          const matching = forSlot.filter(
            attestation => attestation.archive.equals(published.checkpoint.archive.root) && attestation.getSender(),
          );
          return matching.length > 0 ? matching : undefined;
        },
        `attestations for the replacement checkpoint at slot ${replacementSlot}`,
        test.L2_SLOT_DURATION_IN_S * 3,
        0.5,
      );
      const recoveredSigners = attestations.map(attestation => attestation.getSender()!.toString());
      const publishedSigners = published.attestations
        .filter(attestation => !attestation.signature.isEmpty())
        .map(attestation => attestation.address.toString());
      logger.warn(`Replacement checkpoint ${replacementCheckpoint} published`, {
        slot: replacementSlot,
        publishedSigners,
        recoveredSigners,
      });
      // The named validator is still in the committee at the replacement slot, and quorum is measured against that
      // committee rather than against the node count.
      const committeeAtReplacement = await committeeAtSlot(replacementSlot);
      expect(committeeAtReplacement).toContain(namedValidator.toString().toLowerCase());
      expect(publishedSigners.length).toBeGreaterThanOrEqual(computeQuorum(committeeAtReplacement.length));
      expect(recoveredSigners).toContain(namedValidator.toString());

      // Every node converged on the same replacement chain, the removed message has no witness on it, and the
      // replacement has one at the index the removed message used to hold.
      const lastBlock = published.checkpoint.blocks.at(-1)!;
      const lastBlockNumber = BlockNumber(lastBlock.number);
      const lastBlockHash = await lastBlock.hash();
      for (const node of nodes) {
        await waitForBlockNumber(node, lastBlockNumber, {
          tag: 'checkpointed',
          timeout: test.L2_SLOT_DURATION_IN_S * 4,
        });
        const blockData = (await node.getBlockData(lastBlockNumber))!;
        expect(blockData.blockHash.toString()).toEqual(lastBlockHash.toString());
        expect(blockData.checkpointNumber).toEqual(replacementCheckpoint);
        expect(await node.getL1ToL2MessageMembershipWitness(lastBlockNumber, originalSend.msgHash)).toBeUndefined();
        const witness = await node.getL1ToL2MessageMembershipWitness(lastBlockNumber, replacementMsgHash);
        expect(witness).toBeDefined();
        expect(witness![0]).toEqual(replacedIndex);
      }

      // Proven through the existing test prover. The only sequencer failure allowed through is the abandoned
      // slot's own streaming abort, by exact type and reason; every other failure, including a different one at
      // that same slot, still has to be absent.
      const expectedFailure = (event: TrackedSequencerEvent) =>
        event.type === 'checkpoint-build-aborted' &&
        failedSlot(event) === heldSlot &&
        'reason' in event &&
        event.reason === 'inbox_prefix_reorged';
      await waitForProvenCheckpoint(fixture, replacementCheckpoint, { expectedFailure });
      expect(failEvents.filter(event => !expectedFailure(event))).toEqual([]);

      // The same block identity is still canonical once proven, so the convergence above was not undone by the
      // proof advancing the chain.
      for (const node of nodes) {
        expect((await node.getBlockData(lastBlockNumber))!.blockHash.toString()).toEqual(lastBlockHash.toString());
      }
      expect(await context.aztecNode.getCheckpointNumber('proven')).toBeGreaterThanOrEqual(replacementCheckpoint);

      // No node treated the stale proposal as proposer misconduct at any point. Asserted last, so the window it
      // covers runs from before the reorg through recovery and proving rather than stopping at the release.
      for (const index of times(NODE_COUNT, i => i)) {
        expect(
          slashRequests[index].filter(
            args =>
              args.offenseType === OffenseType.BROADCASTED_INVALID_BLOCK_PROPOSAL &&
              args.epochOrSlot === BigInt(heldSlot),
          ),
        ).toEqual([]);
        expect(
          decisions[index].filter(decision => decision.blockHash.equals(heldBlockHash) && decision.slashable),
        ).toEqual([]);
      }
    } finally {
      cleanups.forEach(cleanup => cleanup());
      gates.forEach(gate => gate.release());
      test.proverDelayer.nextWait = undefined;
    }
  });
});
