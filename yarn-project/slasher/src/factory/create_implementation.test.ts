import type { EpochCache } from '@aztec-labs/epoch-cache';
import type { RollupContract, SlasherContract, SlashingProposerContract } from '@aztec-labs/ethereum/contracts';
import type { ViemClient } from '@aztec-labs/ethereum/types';
import { SlotNumber } from '@aztec-labs/foundation/branded-types';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { DateProvider } from '@aztec-labs/foundation/timer';
import { type AztecLMDBStoreV2, openTmpStore } from '@aztec-labs/kv-store/lmdb-v2';
import { type Offense, OffenseType } from '@aztec-labs/stdlib/slashing';
import { type MockProxy, mock, mockDeep } from 'jest-mock-extended';

import { DefaultSlasherConfig } from '../config.js';
import { SlasherOffensesStore } from '../stores/offenses_store.js';
import { createSlasherImplementation } from './create_implementation.js';

describe('createSlasherImplementation', () => {
  const epochDuration = 4;
  const slashOffsetInRounds = 2;

  let kvStore: AztecLMDBStoreV2;
  let rollup: MockProxy<RollupContract>;

  const config = { ...DefaultSlasherConfig, dataStoreMapSizeKb: 0, ethereumSlotDuration: 12 };

  const mockSlashingProposer = (roundSize: number) => {
    const proposer = mockDeep<SlashingProposerContract>();
    proposer.getRoundSize.mockResolvedValue(BigInt(roundSize));
    proposer.getRoundSizeInEpochs.mockResolvedValue(BigInt(roundSize / epochDuration));
    proposer.getSlashOffsetInRounds.mockResolvedValue(BigInt(slashOffsetInRounds));
    proposer.getExecutionDelayInRounds.mockResolvedValue(2n);
    proposer.getLifetimeInRounds.mockResolvedValue(10n);
    proposer.getQuorumSize.mockResolvedValue(BigInt(roundSize / 2 + 1));
    proposer.getSlashingAmounts.mockResolvedValue([1n, 2n, 3n]);
    return proposer;
  };

  const createImplementation = () =>
    createSlasherImplementation(
      config,
      rollup,
      mock<ViemClient>(),
      [],
      mock<EpochCache>(),
      new DateProvider(),
      kvStore,
      SlotNumber(0),
    );

  beforeEach(async () => {
    kvStore = await openTmpStore('slasher-create-implementation-test');
    rollup = mockDeep<RollupContract>();
    rollup.getSlasherContract.mockResolvedValue(mock<SlasherContract>());
    rollup.getEpochDuration.mockResolvedValue(epochDuration);
    rollup.getL1GenesisTime.mockResolvedValue(0n);
    rollup.getSlotDuration.mockResolvedValue(36);
    rollup.getTargetCommitteeSize.mockResolvedValue(4);
  });

  afterEach(async () => {
    await kvStore.close();
  });

  it('buckets offenses stored before a slasher swap by the new round size', async () => {
    const offense: Offense = {
      validator: EthAddress.random(),
      amount: 1n,
      offenseType: OffenseType.PROPOSED_INSUFFICIENT_ATTESTATIONS,
      epochOrSlot: 450n,
    };

    // Slot 450 falls in round 4 under the old 100-slot rounds, and in round 2 under the new 200-slot rounds.
    const oldStore = new SlasherOffensesStore(kvStore, { slashingRoundSize: 100, epochDuration });
    await oldStore.addOffense(offense);

    rollup.getSlashingProposer.mockResolvedValue(mockSlashingProposer(200));
    const client = await createImplementation();

    await expect(client.gatherOffensesForRound(BigInt(2 + slashOffsetInRounds))).resolves.toEqual([offense]);
    await expect(client.gatherOffensesForRound(BigInt(4 + slashOffsetInRounds))).resolves.toEqual([]);
  });
});
