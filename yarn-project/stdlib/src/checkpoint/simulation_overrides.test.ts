import { type FeeHeader, RollupContract } from '@aztec-labs/ethereum/contracts';
import { BlockNumber, CheckpointNumber, TreeLeafIndex } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { createLogger } from '@aztec-labs/foundation/log';
import { jest } from '@jest/globals';
import { mock } from 'jest-mock-extended';

import { TestRollupFeeConfigProvider } from '../gas/rollup_fee_config.js';
import type { CoordinationSignatureContext } from '../p2p/signature_utils.js';
import { CheckpointHeader } from '../rollup/checkpoint_header.js';
import { AppendOnlyTreeSnapshot } from '../trees/append_only_tree_snapshot.js';
import type { ProposedCheckpointData } from './checkpoint_data.js';
import { buildCheckpointSimulationOverridesPlan, computePipelinedParentFeeHeader } from './simulation_overrides.js';

describe('computePipelinedParentFeeHeader', () => {
  let rollup: ReturnType<typeof mock<RollupContract>>;
  let feeConfigProvider: TestRollupFeeConfigProvider;

  beforeEach(() => {
    rollup = mock<RollupContract>();
    feeConfigProvider = new TestRollupFeeConfigProvider({ manaTarget: 10_000n });
  });

  // Use checkpoint 3 so the grandparent (checkpoint 1) is valid
  const pipelinedCheckpointNumber = CheckpointNumber(3);

  const pendingData: ProposedCheckpointData = {
    checkpointNumber: CheckpointNumber(2),
    header: CheckpointHeader.empty(),
    archive: AppendOnlyTreeSnapshot.empty(),
    checkpointOutHash: Fr.ZERO,
    startBlock: BlockNumber(2),
    blockCount: 1,
    totalManaUsed: 5000n,
    feeAssetPriceModifier: 100n,
    inboxMsgTotal: 0n,
  };

  const grandparentFeeHeader: FeeHeader = {
    manaUsed: 3000n,
    excessMana: 1000n,
    ethPerFeeAsset: 500n,
    protocolFee: 50n,
    proverCost: 10n,
  };

  it('returns undefined when checkpoint number is below 2 (genesis grandparent)', async () => {
    const result = await computePipelinedParentFeeHeader({
      checkpointNumber: CheckpointNumber(1),
      proposedCheckpointData: pendingData,
      rollup,
      feeConfigProvider,
      log: createLogger('test'),
    });
    expect(result).toBeUndefined();
  });

  function mockRollup(overrides: { grandparentCheckpoint?: any; manaTarget?: bigint }) {
    rollup.getCheckpoint.mockResolvedValue(overrides.grandparentCheckpoint);
    feeConfigProvider.setFeeConfig({ manaTarget: overrides.manaTarget ?? 10_000n });
  }

  it('computes fee header from grandparent checkpoint', async () => {
    const manaTarget = 10_000n;

    mockRollup({ grandparentCheckpoint: { feeHeader: grandparentFeeHeader }, manaTarget });

    const result = await computePipelinedParentFeeHeader({
      checkpointNumber: pipelinedCheckpointNumber,
      proposedCheckpointData: pendingData,
      rollup,
      feeConfigProvider,
      log: createLogger('test'),
    });

    expect(result).toBeDefined();

    const expected = RollupContract.computeChildFeeHeader(
      grandparentFeeHeader,
      pendingData.totalManaUsed,
      pendingData.feeAssetPriceModifier,
      manaTarget,
    );
    expect(result).toEqual(expected);
  });

  it("uses the provider's current mana target after governance raises it", async () => {
    const startupTarget = 1_000n;
    const raisedTarget = 2_000n;
    mockRollup({ grandparentCheckpoint: { feeHeader: grandparentFeeHeader }, manaTarget: startupTarget });
    feeConfigProvider.setFeeConfig({ manaTarget: raisedTarget });

    const result = await computePipelinedParentFeeHeader({
      checkpointNumber: pipelinedCheckpointNumber,
      proposedCheckpointData: pendingData,
      rollup,
      feeConfigProvider,
      log: createLogger('test'),
    });

    // The grandparent's excess plus used mana (4000) sits between the two targets, so the parent's excess differs.
    expect(result).toEqual(
      RollupContract.computeChildFeeHeader(
        grandparentFeeHeader,
        pendingData.totalManaUsed,
        pendingData.feeAssetPriceModifier,
        raisedTarget,
      ),
    );
  });

  it('reads the grandparent and the mana target at the L1 block the caller simulates at', async () => {
    const simulatedL1Block = 7n;
    rollup.getCheckpoint.mockImplementation((_checkpoint, opts) =>
      opts?.blockNumber === simulatedL1Block
        ? Promise.resolve({ feeHeader: grandparentFeeHeader } as any)
        : Promise.reject(new Error(`Unexpected read at L1 block ${opts?.blockNumber}`)),
    );
    // The provider's head has a target governance set after the simulated block.
    feeConfigProvider.setFeeConfig({ manaTarget: 2_000n, l1BlockNumber: simulatedL1Block + 3n });
    jest
      .spyOn(feeConfigProvider, 'getFeeConfigAt')
      .mockImplementation(blockNumber =>
        blockNumber === simulatedL1Block
          ? Promise.resolve({ ...feeConfigProvider.getFeeConfig(), manaTarget: 1_000n, l1BlockNumber: blockNumber })
          : Promise.reject(new Error(`Unexpected pinned read at L1 block ${blockNumber}`)),
      );

    const result = await computePipelinedParentFeeHeader({
      checkpointNumber: pipelinedCheckpointNumber,
      proposedCheckpointData: pendingData,
      rollup,
      feeConfigProvider,
      l1BlockNumber: simulatedL1Block,
      log: createLogger('test'),
    });

    expect(result).toEqual(
      RollupContract.computeChildFeeHeader(
        grandparentFeeHeader,
        pendingData.totalManaUsed,
        pendingData.feeAssetPriceModifier,
        1_000n,
      ),
    );
  });

  it('throws when grandparent checkpoint is not found', async () => {
    mockRollup({ grandparentCheckpoint: undefined });

    await expect(
      computePipelinedParentFeeHeader({
        checkpointNumber: pipelinedCheckpointNumber,
        proposedCheckpointData: pendingData,
        rollup,
        feeConfigProvider,
        log: createLogger('test'),
      }),
    ).rejects.toThrow(/Grandparent checkpoint or feeHeader missing/);
  });

  it('throws when grandparent checkpoint has no feeHeader', async () => {
    mockRollup({ grandparentCheckpoint: { feeHeader: undefined } });

    await expect(
      computePipelinedParentFeeHeader({
        checkpointNumber: pipelinedCheckpointNumber,
        proposedCheckpointData: pendingData,
        rollup,
        feeConfigProvider,
        log: createLogger('test'),
      }),
    ).rejects.toThrow(/Grandparent checkpoint or feeHeader missing/);
  });

  it('propagates errors from rollup calls', async () => {
    rollup.getCheckpoint.mockRejectedValue(new Error('rpc error'));

    await expect(
      computePipelinedParentFeeHeader({
        checkpointNumber: pipelinedCheckpointNumber,
        proposedCheckpointData: pendingData,
        rollup,
        feeConfigProvider,
        log: createLogger('test'),
      }),
    ).rejects.toThrow(/rpc error/);
  });
});

describe('buildCheckpointSimulationOverridesPlan', () => {
  let rollup: ReturnType<typeof mock<RollupContract>>;
  const feeConfigProvider = new TestRollupFeeConfigProvider({ manaTarget: 10_000n });

  const chainId = new Fr(12345);
  const signatureContext: CoordinationSignatureContext = {
    chainId: chainId.toNumber(),
    rollupAddress: EthAddress.random(),
  };

  beforeEach(() => {
    rollup = mock<RollupContract>();
  });

  const checkpointNumberUnderTest = CheckpointNumber(2);

  const grandparentFeeHeader: FeeHeader = {
    manaUsed: 3000n,
    excessMana: 1000n,
    ethPerFeeAsset: 500n,
    protocolFee: 50n,
    proverCost: 10n,
  };

  function mockGrandparentFeeHeader() {
    rollup.getCheckpoint.mockResolvedValue({ feeHeader: grandparentFeeHeader } as any);
  }

  function makeProposedParent(checkpointNumber: CheckpointNumber): ProposedCheckpointData {
    return {
      checkpointNumber,
      header: CheckpointHeader.empty(),
      archive: new AppendOnlyTreeSnapshot(Fr.random(), TreeLeafIndex(1)),
      checkpointOutHash: Fr.random(),
      startBlock: BlockNumber(1),
      blockCount: 1,
      totalManaUsed: 5000n,
      feeAssetPriceModifier: 100n,
      inboxMsgTotal: 1500n,
    };
  }

  it('pins both pending and proven to the snapshot when no proposed/invalidate input is provided', async () => {
    const plan = await buildCheckpointSimulationOverridesPlan({
      checkpointNumber: checkpointNumberUnderTest,
      checkpointedCheckpointNumber: CheckpointNumber(4),
      rollup,
      feeConfigProvider,
      signatureContext,
      log: createLogger('test'),
    });
    expect(plan?.chainTipsOverride?.pending).toEqual(CheckpointNumber(4));
    expect(plan?.chainTipsOverride?.proven).toEqual(CheckpointNumber(4));
    expect(plan?.pendingCheckpointState).toBeUndefined();
  });

  it('overrides the full pending checkpoint cell from a pipelined parent', async () => {
    mockGrandparentFeeHeader();
    const proposedData = makeProposedParent(CheckpointNumber(1));

    const plan = await buildCheckpointSimulationOverridesPlan({
      checkpointNumber: checkpointNumberUnderTest,
      proposedCheckpointData: proposedData,
      checkpointedCheckpointNumber: CheckpointNumber(0),
      rollup,
      feeConfigProvider,
      signatureContext,
      log: createLogger('test'),
    });

    expect(plan?.chainTipsOverride?.pending).toEqual(CheckpointNumber(1));
    expect(plan?.chainTipsOverride?.proven).toEqual(CheckpointNumber(1));
    expect(plan?.pendingCheckpointState?.archive).toEqual(proposedData.archive.root);
    expect(plan?.pendingCheckpointState?.slotNumber).toEqual(proposedData.header.slotNumber);
    expect(plan?.pendingCheckpointState?.headerHash).toEqual(proposedData.header.hash());
    expect(plan?.pendingCheckpointState?.outHash).toEqual(proposedData.checkpointOutHash);
    expect(plan?.pendingCheckpointState?.payloadDigest).toBeDefined();
    expect(plan?.pendingCheckpointState?.feeHeader).toBeDefined();
    // Without this the parent reads as having consumed no Inbox messages, inflating the child's consumed count.
    expect(plan?.pendingCheckpointState?.inboxMsgTotal).toEqual(proposedData.inboxMsgTotal);
  });

  it('throws when the pipelined parent does not match the expected parent checkpoint', async () => {
    const proposedData = makeProposedParent(CheckpointNumber(5));

    await expect(
      buildCheckpointSimulationOverridesPlan({
        checkpointNumber: checkpointNumberUnderTest,
        proposedCheckpointData: proposedData,
        checkpointedCheckpointNumber: CheckpointNumber(0),
        rollup,
        feeConfigProvider,
        signatureContext,
        log: createLogger('test'),
      }),
    ).rejects.toThrow(/does not match expected parent/);
  });

  it('throws when both proposedCheckpointData and invalidateToPendingCheckpointNumber are provided', async () => {
    const proposedData = makeProposedParent(CheckpointNumber(1));

    await expect(
      buildCheckpointSimulationOverridesPlan({
        checkpointNumber: checkpointNumberUnderTest,
        proposedCheckpointData: proposedData,
        invalidateToPendingCheckpointNumber: CheckpointNumber(0),
        checkpointedCheckpointNumber: CheckpointNumber(0),
        rollup,
        feeConfigProvider,
        signatureContext,
        log: createLogger('test'),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('sets pending and proven from an invalidation rollback without archive/fee overrides', async () => {
    const plan = await buildCheckpointSimulationOverridesPlan({
      checkpointNumber: checkpointNumberUnderTest,
      invalidateToPendingCheckpointNumber: CheckpointNumber(0),
      checkpointedCheckpointNumber: CheckpointNumber(2),
      rollup,
      feeConfigProvider,
      signatureContext,
      log: createLogger('test'),
    });
    expect(plan?.chainTipsOverride?.pending).toEqual(CheckpointNumber(0));
    expect(plan?.chainTipsOverride?.proven).toEqual(CheckpointNumber(0));
    expect(plan?.pendingCheckpointState).toBeUndefined();
  });
});
