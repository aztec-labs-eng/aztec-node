import type { Archiver } from '@aztec-labs/archiver';
import {
  AmsterdamForkDetector,
  getMaxL1TxGasLimit,
  isAmsterdamBlock,
  waitUntilL1Timestamp,
} from '@aztec-labs/ethereum/l1-tx-utils';
import { assertAnvilSupportsHardfork, restartAnvilOnHardfork } from '@aztec-labs/ethereum/test';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { L2BlockSourceEvents } from '@aztec-labs/stdlib/block';
import {
  getProofSubmissionDeadlineTimestamp,
  getSlotAtTimestamp,
  getSlotRangeForEpoch,
  getTimestampForSlot,
} from '@aztec-labs/stdlib/epoch-helpers';
import { jest } from '@jest/globals';

import { PROVING_SLOT_TIMING, setupWithProver } from '../setup.js';
import type { SingleNodeTestContext } from '../single_node_test_context.js';

jest.setTimeout(15 * 60 * 1000);

const EPOCH_DURATION = 6;
const FORK_EPOCH = 2;
const FORK_SLOT_INDEX = 3;
const RECOVERY_SLOTS = 3;
// Bounds the state dump: each kept state is a full snapshot, and 128 blocks still cover an epoch plus its proof
// submission window, which the archiver and prover read at past L1 blocks.
const ANVIL_PRUNE_HISTORY = 128;

// Crosses the L1 fork from Osaka to Amsterdam mid-epoch on a live single sequencer plus fake-proof prover node. Anvil
// cannot change hardfork at runtime, so the test restarts it on Amsterdam from a state dump with history, right before
// the target slot. The sequencer may miss slots at the fork, and the node then prunes the blocks it already built for
// them, but it must propose again within RECOVERY_SLOTS slots. The epochs around the fork must be proven with no epoch
// prune, and every L1 tx must stay within the gas cap of its fork.
describe('single-node/l1-hardfork/osaka_to_amsterdam', () => {
  let test: SingleNodeTestContext;

  beforeAll(async () => {
    await assertAnvilSupportsHardfork('amsterdam');
    test = await setupWithProver({
      ...PROVING_SLOT_TIMING,
      aztecEpochDuration: EPOCH_DURATION,
      anvilHardfork: 'osaka',
      anvilPruneHistory: ANVIL_PRUNE_HISTORY,
    });
  });

  afterAll(async () => {
    await test?.teardown();
  });

  it('recovers within a few slots and proves every epoch around the fork', async () => {
    const { context, constants, monitor, logger, l1Client } = test;
    const proverNode = test.proverNodes[0].getProverNode()!;
    const archiver = context.aztecNodeService.getBlockSource() as Archiver;
    const l1StartBlock = await l1Client.getBlockNumber();

    expect(isAmsterdamBlock(await l1Client.getBlock())).toBe(false);

    // Epoch 1 runs on Osaka in real time and is proven before L1 is touched, so no proof submission is in flight
    // during the restart: a submission that hits the outage is marked failed without a retry.
    await test.warpToEpochStart(1);
    const { failEvents } = test.watchSequencerEvents([context.sequencer!]);
    const unprovenPruneEpochs: EpochNumber[] = [];
    const uncheckpointedPrunedSlots: SlotNumber[] = [];
    archiver.events.on(L2BlockSourceEvents.L2PruneUnproven, ({ epochNumber }) => unprovenPruneEpochs.push(epochNumber));
    archiver.events.on(L2BlockSourceEvents.L2PruneUncheckpointed, ({ blocks }) =>
      uncheckpointedPrunedSlots.push(...blocks.map(block => block.slot)),
    );
    await test.waitUntilEpochStarts(FORK_EPOCH);
    const epoch1Tip = (await monitor.run()).checkpointNumber;

    const [forkEpochStart] = getSlotRangeForEpoch(EpochNumber(FORK_EPOCH), constants);
    const targetSlot = SlotNumber(forkEpochStart + FORK_SLOT_INDEX);
    const restartTs = getTimestampForSlot(targetSlot, constants) - BigInt(constants.ethereumSlotDuration);
    await test.waitUntilProvenCheckpointNumber(epoch1Tip, Number(restartTs) - context.dateProvider.nowInSeconds() - 1);
    // The proof can show up on L1 before the prover node reads its own receipt and marks the job completed.
    await retryUntil(
      async () => {
        const jobs = await proverNode.getJobs();
        const epoch1Done = jobs.some(job => job.epochNumber === 1 && job.status === 'completed');
        return epoch1Done && !jobs.some(job => job.status === 'publishing-proof');
      },
      'epoch 1 proving job completed',
      { deadline: new Date((Number(restartTs) - 1) * 1000), dateProvider: context.dateProvider },
      0.1,
    );

    await waitUntilL1Timestamp(l1Client, restartTs);
    const restarted = await restartAnvilOnHardfork(context.anvil!, context.cheatCodes.eth, l1Client, {
      hardfork: 'amsterdam',
      stateDir: context.directoryToCleanup,
      startOpts: { pruneHistory: ANVIL_PRUNE_HISTORY, dateProvider: context.dateProvider },
    });
    context.anvil = restarted.anvil;
    const forkSlot = getSlotAtTimestamp(restarted.forkBlock.timestamp, constants);
    logger.warn(`Switched L1 from Osaka to Amsterdam at block ${restarted.forkBlock.number} in slot ${forkSlot}`);
    expect(await new AmsterdamForkDetector(l1Client).isActive()).toBe(true);
    const lastRecoverySlot = SlotNumber(forkSlot + RECOVERY_SLOTS);

    // Sequencer failures are tolerated only while the node recovers from the outage.
    await monitor.waitUntilL2Slot(SlotNumber(lastRecoverySlot + 1));
    const failuresAfterRecovery = failEvents.length;

    await test.waitUntilEpochStarts(FORK_EPOCH + 2);
    const finalTip = (await monitor.run()).checkpointNumber;
    const lastDeadline = getProofSubmissionDeadlineTimestamp(EpochNumber(FORK_EPOCH + 1), constants);
    await test.waitUntilProvenCheckpointNumber(finalTip, Number(lastDeadline) - context.dateProvider.nowInSeconds());
    const l1EndBlock = await l1Client.getBlockNumber();

    const checkpoints = await context.aztecNode.getCheckpoints(CheckpointNumber(epoch1Tip + 1), finalTip - epoch1Tip);
    const recoverySlot = checkpoints.map(c => c.header.slotNumber).find(slot => slot >= forkSlot);
    logger.info(`First checkpoint on Amsterdam proposed in slot ${recoverySlot}`, { forkSlot });
    expect(recoverySlot).toBeDefined();
    expect(recoverySlot! - forkSlot).toBeLessThanOrEqual(RECOVERY_SLOTS);

    expect(unprovenPruneEpochs).toEqual([]);
    // The node prunes the blocks it built for a slot whose checkpoint does not land on L1, which the outage can cause
    // from the target slot through the last recovery slot.
    expect(uncheckpointedPrunedSlots.filter(slot => slot < targetSlot || slot > lastRecoverySlot)).toEqual([]);
    const jobs = await proverNode.getJobs();
    expect(jobs.filter(job => job.status === 'failed' || job.status === 'timed-out')).toEqual([]);
    test.assertNoFailuresFromSequencers(
      failEvents.slice(failuresAfterRecovery).filter(e => !('slot' in e) || e.slot > lastRecoverySlot),
    );

    // Every L1 tx in the run comes from the node's publishers or the prover node.
    const txs = [];
    for (let blockNumber = l1StartBlock + 1n; blockNumber <= l1EndBlock; blockNumber++) {
      const block = await l1Client.getBlock({ blockNumber, includeTransactions: true });
      txs.push(...block.transactions.map(tx => ({ hash: tx.hash, gas: tx.gas, amsterdam: isAmsterdamBlock(block) })));
    }
    expect(txs.some(tx => !tx.amsterdam) && txs.some(tx => tx.amsterdam)).toBe(true);
    expect(txs.filter(tx => tx.gas > getMaxL1TxGasLimit(tx.amsterdam))).toEqual([]);
  });
});
