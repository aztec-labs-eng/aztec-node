import { InboxAbi } from '@aztec-foundation/l1-artifacts';

import type { Archiver } from '@aztec-labs/archiver';
import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { generateClaimSecret } from '@aztec-labs/aztec.js/ethereum';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { createLogger } from '@aztec-labs/aztec.js/log';
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging';
import { InboxContract, MULTI_CALL_3_ADDRESS, RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, CheckpointNumber, type SlotNumber } from '@aztec-labs/foundation/branded-types';
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
import { OffenseType } from '@aztec-labs/stdlib/slashing';
import type { BlockProposalObservers } from '@aztec-labs/validator-client';
import { type Hex, encodeFunctionData } from 'viem';

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

/**
 * L1 blocks the content-changing reorg reserves for itself: the replaced message send plus the hold. The window is
 * asserted to have stayed inside it, so "nothing else was replaced away" is a bound set in advance.
 */
const REORG_WINDOW_L1_BLOCKS = 24;

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

    // ---------------------------------------------------------------------------------------------------------
    // Content-changing L1 reorg while a checkpoint is in flight.
    //
    // A changed message prefix is where multi-node behaviour adds information a single node cannot: the proposer
    // and the validators observe the reorg at different moments, a validator must read its own prefix mismatch as
    // local-view state rather than proposer misconduct, and the committee has to recover quorum on a replacement
    // built from the canonical prefix. The stale block is gossiped from the gate after L1 has already changed, so
    // the validator's mismatch is against a parent that is still available to re-execute against, not against a
    // block it simply never received.
    // ---------------------------------------------------------------------------------------------------------
    const { l1Client, l1ContractAddresses } = context.deployL1ContractsValues;
    const inbox = new InboxContract(l1Client, l1ContractAddresses.inboxAddress.toString());
    const rollup = new RollupContract(l1Client, l1ContractAddresses.rollupAddress.toString());
    const archivers = nodes.map(node => node.getBlockSource() as Archiver);

    /** An Inbox send together with the exact call that produced it, so a reorg can replay or replace it verbatim. */
    const prepareMessage = async (content: Fr) => {
      const recipient = await AztecAddress.random();
      const secretHash = Fr.random();
      const version = BigInt(await rollup.getVersion());
      return {
        content,
        call: {
          to: l1ContractAddresses.inboxAddress.toString() as Hex,
          from: l1Client.account.address,
          input: encodeFunctionData({
            abi: InboxAbi,
            functionName: 'sendL2Message',
            args: [{ actor: recipient.toString(), version }, content.toString(), secretHash.toString()],
          }),
          // Estimated against the pre-reorg chain the bucket is warm; replayed after the rollback it is opened cold
          // and costs far more, so an estimated limit runs out of gas and the message is never emitted.
          gas: 1_000_000n,
        },
        send: () => sendL1ToL2Message({ recipient, content, secretHash }, { l1Client, l1ContractAddresses }),
      };
    };

    // The parent checkpoint stays strictly outside the reorg range, so the window can never drop a publication.
    const publishedParent = await test.monitor.run(true);
    const l1BlockBeforeReorgWindow = BigInt(publishedParent.l1BlockNumber);
    const replacedIndex = (await inbox.getState()).totalMessagesInserted;

    const original = await prepareMessage(Fr.random());
    const replacement = await prepareMessage(Fr.random());

    // Armed before the message exists, so no proposer can consume it before there is anything to hold.
    const crossesReplacement: CheckpointPhasePredicate = event =>
      event.phase === 'block-ready-to-broadcast' && event.isStandalone && event.consumedMessageCount > replacedIndex;
    const armings = gates.map(gate => gate.arm(crossesReplacement));
    armings.forEach(arming => {
      // Only the proposing node matches; the others are released untouched at the end of the case, and their
      // watchdogs must not surface as unhandled rejections in the meantime.
      arming.matched.catch(() => {});
      arming.completed.catch(() => {});
      arming.failed.catch(() => {});
    });

    const originalSend = await original.send();
    logger.warn(`Sent the message the reorg will replace`, {
      msgHash: originalSend.msgHash.toString(),
      index: originalSend.globalLeafIndex.toBigInt(),
      l1BlockNumber: originalSend.txReceipt.blockNumber,
    });
    expect(originalSend.globalLeafIndex.toBigInt()).toEqual(replacedIndex);

    const prunes: PerNode<L2Block> = times(NODE_COUNT, () => []);
    const slashRequests: PerNode<WantToSlashArgs> = times(NODE_COUNT, () => []);
    const aborts: ObservedAbort[] = [];
    const cleanups: (() => void)[] = [];

    try {
      const held = await Promise.race(armings.map(arming => arming.matched));
      const proposerIndex = gates.findIndex(gate => gate.heldEvent?.blockHash.equals(held.blockHash));
      expect(proposerIndex).toBeGreaterThanOrEqual(0);
      // Every other node is released immediately: one arming holds one block, and a gate left armed on a
      // non-proposer would hold a later, unrelated checkpoint.
      gates.forEach((gate, index) => index !== proposerIndex && gate.release());

      // The named validator is any committee member that is not the proposer, so its prefix mismatch is a peer's
      // verdict on someone else's block rather than a node disagreeing with itself.
      const validatorIndex = (proposerIndex + 1) % NODE_COUNT;
      const namedValidator = fixture.validators[validatorIndex].attester;
      logger.warn(`Holding block ${held.blockNumber} of checkpoint ${held.checkpointNumber} at slot ${held.slot}`, {
        proposerIndex,
        validatorIndex,
        namedValidator: namedValidator.toString(),
        consumedMessageCount: held.consumedMessageCount,
      });

      const holder = gates[proposerIndex];
      const holderArming = armings[proposerIndex];
      const heldSlot: SlotNumber = held.slot;
      const heldBlockHash: BlockHash = held.blockHash;

      const reorged = await Promise.race([
        (async () => {
          // The held block crosses the replacement index and its parent does not, which is what makes the stale
          // block's prefix the one the reorg invalidates.
          const parentCount = BigInt(
            (await archivers[proposerIndex].getBlockData({ number: BlockNumber(held.blockNumber - 1) }))!.header.state
              .l1ToL2MessageTree.nextAvailableLeafIndex,
          );
          expect(parentCount).toBeLessThanOrEqual(replacedIndex);
          expect(held.consumedMessageCount).toBeGreaterThan(replacedIndex);

          // The named validator can re-execute against the stale block's parent, so its rejection below is about
          // the Inbox prefix and not about a parent it never had.
          const parentOnValidator = await retryUntil(
            () => archivers[validatorIndex].getBlockData({ number: BlockNumber(held.blockNumber - 1) }),
            `validator ${validatorIndex} holds the stale block's parent`,
            test.L2_SLOT_DURATION_IN_S,
            0.2,
          );
          const parentOnProposer = (await archivers[proposerIndex].getBlockData({
            number: BlockNumber(held.blockNumber - 1),
          }))!;
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
          // the scan looks for that as well as for direct rollup calls.
          const head = BigInt((await test.monitor.run(true)).l1BlockNumber);
          const reorgFrom = originalSend.txReceipt.blockNumber;
          expect(reorgFrom).toBeGreaterThan(l1BlockBeforeReorgWindow);
          expect(head - reorgFrom).toBeLessThan(BigInt(REORG_WINDOW_L1_BLOCKS));
          const rollupSenders = [l1ContractAddresses.rollupAddress.toString(), MULTI_CALL_3_ADDRESS].map(address =>
            address.toLowerCase(),
          );
          for (let n = reorgFrom; n <= head; n++) {
            const block = await l1Client.getBlock({ blockNumber: n, includeTransactions: true });
            expect(block.transactions.filter(tx => rollupSenders.includes(tx.to?.toLowerCase() ?? ''))).toHaveLength(0);
          }

          // The suffix is swapped atomically for one that carries a *different* message at the same index: same
          // count, changed leaf and rolling hash. Mining is paused across the swap so the height and hash
          // comparisons read a chain that is not moving underneath them.
          const anchorBefore = await l1Client.getBlock({ blockNumber: reorgFrom });
          const headBefore = await l1Client.getBlock({ blockNumber: head });
          const stateBefore = await inbox.getState();
          holderArming.matched.catch(() => {});
          await context.cheatCodes.eth.execWithPausedAnvil(async () => {
            await context.cheatCodes.eth.reorgWithReplacement(Number(head - reorgFrom + 1n), [[replacement.call]]);
            const [anchorAfter, headAfter] = await Promise.all([
              l1Client.getBlock({ blockNumber: reorgFrom }),
              l1Client.getBlock({ blockNumber: head }),
            ]);
            expect(headAfter.number).toEqual(headBefore.number);
            expect(anchorAfter.hash).not.toEqual(anchorBefore.hash);
          });

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
            async () =>
              (await archivers[proposerIndex].getBlockData({ number: BlockNumber(held.blockNumber) })) === undefined,
            'the proposer prunes the block built on the replaced prefix',
            test.L2_SLOT_DURATION_IN_S * 2,
            0.5,
          );
          expect(
            (await archivers[validatorIndex].getBlockData({
              number: BlockNumber(held.blockNumber - 1),
            }))!.archive.root.toString(),
          ).toEqual(parentOnProposer.archive.root.toString());

          return { reorgFrom, head };
        })(),
        holderArming.failed,
      ]);
      logger.warn(`Replaced the L1 suffix`, reorged);

      // Releasing gossips the already-signed stale block: its parent is available, and its prefix no longer is.
      holder.release();
      await holderArming.completed.catch(() => {});

      // The named validator's *first* Inbox metadata comparison for this exact block is the mismatch. The final
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

      // And its completed decision, once the bounded retries are spent, is a non-punitive rejection.
      const finalDecision = await retryUntil(
        () =>
          Promise.resolve(
            decisions[validatorIndex].find(decision => decision.blockHash.equals(heldBlockHash) && !decision.accepted),
          ),
        `validator ${validatorIndex} finishes rejecting the stale block`,
        test.L2_SLOT_DURATION_IN_S * 3,
        0.2,
      );
      expect(finalDecision.slashable).toBe(false);
      expect(finalDecision.reason).toEqual('inbox_prefix_mismatch');
      logger.warn(`Named validator rejected the stale block non-punitively`, {
        namedValidator: namedValidator.toString(),
        reason: finalDecision.reason,
      });

      // No node treated the stale proposal as proposer misconduct, observed through the whole decision rather than
      // only at the first check.
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

      // The proposer continues from a stale checkpoint cursor against its reconciled message source and gives up
      // the slot, reporting the reorg rather than a generic timeout.
      const abort = await retryUntil(
        () => Promise.resolve(aborts.find(event => event.slot === heldSlot)),
        `the proposer abandons slot ${heldSlot}`,
        test.L2_SLOT_DURATION_IN_S * 3,
        0.2,
      );
      expect(abort.reason).toEqual('inbox_prefix_reorged');

      // Nothing was published for the abandoned slot, and the removed message is not on the canonical chain.
      const replacementReady = await retryUntil(
        async () => (await context.aztecNode.getL1ToL2MessageIndex(replacement.content)) !== undefined,
        'the replacement message reaches L2',
        test.L2_SLOT_DURATION_IN_S * 4,
        0.5,
      );
      expect(replacementReady).toBe(true);
      const replacementIndex = await context.aztecNode.getL1ToL2MessageIndex(replacement.content);
      expect(replacementIndex).toEqual(replacedIndex);
      expect(await context.aztecNode.getL1ToL2MessageIndex(originalSend.msgHash)).toBeUndefined();

      const replacementCheckpoint = await fixture.test.assertMultipleBlocksPerSlot(1, {
        wait: true,
        archiver: fixture.archiver,
      });
      // Read from the archiver rather than the node RPC, because the attestations the committee signed only exist
      // on the published checkpoint.
      const published = await retryUntil(
        async () => {
          const [checkpoint] = await fixture.archiver.getCheckpoints({ from: replacementCheckpoint, limit: 1 });
          return checkpoint;
        },
        `checkpoint ${replacementCheckpoint} publishes`,
        test.L2_SLOT_DURATION_IN_S * 4,
        0.5,
      );
      expect(published.checkpoint.header.slotNumber).not.toEqual(heldSlot);

      // Quorum recovered, and the named validator actually signed it: a quorum alone would let the
      // validator-specific claim pass vacuously.
      const signers = published.attestations.filter(attestation => !attestation.signature.isEmpty());
      logger.warn(`Replacement checkpoint ${replacementCheckpoint} published`, {
        slot: published.checkpoint.header.slotNumber,
        signers: signers.map(attestation => attestation.address.toString()),
      });
      expect(signers.length).toBeGreaterThan(NODE_COUNT / 2);
      expect(signers.map(attestation => attestation.address.toString())).toContain(namedValidator.toString());

      // Every node converged on the same replacement chain, and the removed message has no witness on it while
      // the replacement does, at the index the removed one used to hold.
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
        expect(await node.getL1ToL2MessageMembershipWitness(lastBlockNumber, originalSend.msgHash)).toBeUndefined();
        const witness = await node.getL1ToL2MessageMembershipWitness(lastBlockNumber, replacement.content);
        expect(witness).toBeDefined();
        expect(witness![0]).toEqual(replacedIndex);
      }

      // Proven through the existing test prover. The one expected sequencer failure is the abandoned slot, which
      // was verified above by exact slot and reason; everything else still has to be absent.
      await waitForProvenCheckpoint(fixture, replacementCheckpoint, {
        expectedFailure: event => failedSlot(event) === heldSlot,
      });
      expect(failEvents.filter(event => failedSlot(event) !== heldSlot)).toEqual([]);
    } finally {
      cleanups.forEach(cleanup => cleanup());
      gates.forEach(gate => gate.release());
    }
  });
});
