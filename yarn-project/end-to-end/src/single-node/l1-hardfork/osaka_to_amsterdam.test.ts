import type { Archiver } from '@aztec-labs/archiver';
import {
  AmsterdamForkDetector,
  getMaxL1TxGasLimit,
  isAmsterdamBlock,
  waitUntilL1Timestamp,
} from '@aztec-labs/ethereum/l1-tx-utils';
import { assertAnvilSupportsHardfork, restartAnvilOnHardfork } from '@aztec-labs/ethereum/test';
import { CheckpointNumber, EpochNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
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
// the target slot. The sequencer may miss slots at the fork but must propose again within RECOVERY_SLOTS slots, the
// epochs around the fork must be proven with no prune, and every L1 tx must stay within the gas cap of its fork.
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
    const prunes: L2BlockSourceEvents[] = [];
    for (const event of [L2BlockSourceEvents.L2PruneUnproven, L2BlockSourceEvents.L2PruneUncheckpointed] as const) {
      archiver.events.on(event, () => prunes.push(event));
    }
    await test.waitUntilEpochStarts(FORK_EPOCH);
    const epoch1Tip = (await monitor.run()).checkpointNumber;

    const [forkEpochStart] = getSlotRangeForEpoch(EpochNumber(FORK_EPOCH), constants);
    const targetSlot = SlotNumber(forkEpochStart + FORK_SLOT_INDEX);
    const restartTs = getTimestampForSlot(targetSlot, constants) - BigInt(constants.ethereumSlotDuration);
    await test.waitUntilProvenCheckpointNumber(epoch1Tip, Number(restartTs) - context.dateProvider.nowInSeconds() - 1);
    expect(await proverNode.getJobs()).not.toContainEqual(expect.objectContaining({ status: 'publishing-proof' }));

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

    // Sequencer failures are tolerated only while the node recovers from the outage.
    await monitor.waitUntilL2Slot(SlotNumber(forkSlot + RECOVERY_SLOTS + 1));
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

    expect(prunes).toEqual([]);
    const jobs = await proverNode.getJobs();
    expect(jobs.filter(job => job.status === 'failed' || job.status === 'timed-out')).toEqual([]);
    test.assertNoFailuresFromSequencers(
      failEvents.slice(failuresAfterRecovery).filter(e => !('slot' in e) || e.slot > forkSlot + RECOVERY_SLOTS),
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
