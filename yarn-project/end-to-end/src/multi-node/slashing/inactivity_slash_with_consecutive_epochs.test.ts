import type { EthAddress } from '@aztec-labs/aztec.js/addresses';
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { unique } from '@aztec-labs/foundation/collection';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { OffenseType } from '@aztec-labs/slasher';
import { jest } from '@jest/globals';
import 'jest-extended';

import { InactivityTest } from './inactivity_setup.js';

jest.setTimeout(1000 * 60 * 10);

// Inactivity slashing on the shared `InactivityTest` fixture (mock-gossip bus, 6 nodes, fake prover,
// epoch=2, proofSubEpochs=1024, sentinelEnabled).
describe('multi-node/slashing/inactivity_slash_with_consecutive_epochs', () => {
  let test: InactivityTest;

  const slashInactivityConsecutiveEpochThreshold = 3;

  beforeAll(async () => {
    test = await InactivityTest.setup({
      slashInactivityConsecutiveEpochThreshold,
      inactiveNodeCount: 1,
    });
  });

  afterAll(async () => {
    await test?.teardown();
  });

  // Consecutive-epoch threshold is respected: one validator is offline from genesis, while another runs normally
  // past the grace period, goes offline for one epoch fewer than the threshold, and comes back. Asserts that offenses
  // and slash events target only the permanently-offline validator (never the temporarily-offline one).
  it('only slashes validator inactive for N consecutive epochs', async () => {
    const [offlineValidator] = test.offlineValidators;
    const observer = test.activeNodes[0];
    const temporarilyOfflineNode = test.activeNodes.at(-1)!;
    const [temporarilyOfflineValidator] = temporarilyOfflineNode.getSequencer()!.validatorAddresses!;

    const {
      aztecEpochDuration,
      slashingExecutionDelayInRounds,
      slashingOffsetInRounds,
      slashingRoundSizeInEpochs,
      aztecSlotDuration,
      slashGracePeriodL2Slots,
    } = test.config;

    // The setup warp leaves the last grace epochs with every proposer recorded as missed, online or not, and the
    // consecutive-epoch lookback counts those epochs. Keep the validator online through the first epoch after the
    // grace period so that epoch breaks any streak carried over from setup.
    const firstSlashableEpoch = Math.ceil(slashGracePeriodL2Slots / aztecEpochDuration);
    const firstOfflineEpoch = firstSlashableEpoch + 1;
    const lastOfflineEpoch = firstOfflineEpoch + slashInactivityConsecutiveEpochThreshold - 2;

    // With proposer pipelining, a slot's proposal is built and attested before the slot starts, so duties of adjacent
    // epochs overlap in wall-clock time. Both transitions are placed to shorten the outage rather than extend it into
    // the epochs around it: the validator goes offline at the last slot before the window, once every proposal of the
    // previous epoch has been received and attested, and comes back at the first slot of the last offline epoch, an
    // Ethereum slot before the duties of the epoch after the window begin. The sentinel may then record fewer than
    // threshold-1 inactive epochs, which is still a streak below the threshold.
    const disableAtSlot = SlotNumber(firstOfflineEpoch * aztecEpochDuration - 1);
    const reenableAtSlot = SlotNumber(lastOfflineEpoch * aztecEpochDuration);

    // Subscribe before the outage: the permanently-offline validator can be slashed before the wait below ends.
    const slashed: EthAddress[] = [];
    test.rollup.listenToSlash(args => {
      test.logger.warn(`Slashed ${args.attester.toString()}`);
      slashed.push(args.attester);
    });

    await test.monitor.waitUntilL2Slot(disableAtSlot);
    await temporarilyOfflineNode.setConfig({ disabledValidators: [temporarilyOfflineValidator] });
    test.logger.warn(`Disabled validator ${temporarilyOfflineValidator}`, { l2Slot: test.monitor.l2SlotNumber });

    await test.monitor.waitUntilL2Slot(reenableAtSlot);
    await temporarilyOfflineNode.setConfig({ disabledValidators: [] });
    test.logger.warn(`Re-enabled validator ${temporarilyOfflineValidator}`, { l2Slot: test.monitor.l2SlotNumber });

    // Wait until the sentinel has judged the epoch after the offline window, the last one that could close a streak
    // for the temporarily-offline validator, and until the permanently-offline validator has an offense.
    const offensesTimeout = slashInactivityConsecutiveEpochThreshold * aztecEpochDuration * aztecSlotDuration * 4;
    await retryUntil(
      async () => {
        const stats = await observer.getValidatorStats(temporarilyOfflineValidator);
        return stats?.allTimeEpochPerformance.some(p => p.epoch > lastOfflineEpoch + 1);
      },
      'sentinel past the offline window',
      offensesTimeout,
    );
    // Offenses are stored through their own queue, and a sentinel catching up judges several epochs back to back.
    await test.monitor.waitUntilNextL2Slot();

    test.logger.warn(`Waiting until offenses are created for ${offlineValidator}`);
    const offenses = await retryUntil(
      async () => {
        const offenses = await observer.getSlashOffenses('all');
        return offenses.some(o => o.validator.equals(offlineValidator)) ? offenses : undefined;
      },
      'slash offenses',
      offensesTimeout,
    );

    const temporarilyOfflineStats = await observer.getValidatorStats(temporarilyOfflineValidator);
    test.logger.warn(`Epoch performance for ${temporarilyOfflineValidator}`, {
      performance: temporarilyOfflineStats?.allTimeEpochPerformance,
    });

    expect(unique(offenses.map(o => o.validator.toString()))).toEqual([offlineValidator.toString()]);
    expect(unique(offenses.map(o => o.offenseType))).toEqual([OffenseType.INACTIVITY]);

    test.logger.warn(
      `Expecting offline validator ${offlineValidator} to be slashed but not ${temporarilyOfflineValidator}`,
    );

    // Wait until after the slashing would have executed for inactivity
    // Note that this may take some time if the offline validator is elected as proposer enough times
    // that we never get to collect enough votes in a round to trigger the slash
    const attemptsInRounds = 3;
    const delayInEpochs =
      attemptsInRounds * slashingRoundSizeInEpochs + // How many rounds to wait until the slash is voted
      (slashingExecutionDelayInRounds + slashingOffsetInRounds) * slashingRoundSizeInEpochs + // Wait for execution delay
      4; // A bit extra

    const timeout = delayInEpochs * aztecEpochDuration * aztecSlotDuration;
    test.logger.warn(`Waiting ${timeout}s (${delayInEpochs} epochs) until for slash`);
    await retryUntil(
      () => slashed.length > 0,
      'slash executed',
      delayInEpochs * aztecEpochDuration * aztecSlotDuration * 2,
    );

    await sleep(1000); // Wait a bit to ensure no more slashes are recorded
    expect(unique(slashed.map(addr => addr.toString()))).toEqual([offlineValidator.toString()]);
  });
});
