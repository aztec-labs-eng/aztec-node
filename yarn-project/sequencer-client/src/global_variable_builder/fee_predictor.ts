import { type L1FeeData, MAX_FEE_ASSET_PRICE_MODIFIER_BPS } from '@aztec-labs/ethereum/contracts';
import type { SlotNumber } from '@aztec-labs/foundation/branded-types';
import {
  GasFees,
  MIN_ETH_PER_FEE_ASSET,
  ManaUsageEstimate,
  computeExcessMana,
  computeManaMinFee,
} from '@aztec-labs/stdlib/gas';

/** Rollup state a set of fee predictions is computed from, read at a single L1 block. */
export type FeeOracleState = {
  lastSlot: SlotNumber;
  excessMana: bigint;
  ethPerFeeAsset: bigint;
  manaTarget: bigint;
  manaLimit: bigint;
  provingCostPerManaEth: bigint;
  epochDuration: bigint;
  protocolFeeMarginBps: bigint;
  /** Pre-resolved L1 fees for each slot in the prediction window. */
  l1FeesBySlot: L1FeeData[];
};

/**
 * Predicts min fees for the upcoming slots covered by `state.l1FeesBySlot`, from rollup state read at one L1 block.
 * A new oracle update can activate at startSlot + LAG, so only the first LAG entries are guaranteed stable.
 */
export function computeFeePredictions(state: FeeOracleState, manaUsage: ManaUsageEstimate): GasFees[] {
  const assumedManaUsed = getAssumedManaUsed(state, manaUsage);

  const result: GasFees[] = [];
  let { excessMana } = state;
  let { ethPerFeeAsset } = state;

  // Slot 0: current state (next available slot after last checkpoint)
  result.push(computeGasFees(state, excessMana, ethPerFeeAsset, state.l1FeesBySlot[0]));

  // Slots 1..LAG-1: advance excessMana with the assumed mana usage per checkpoint,
  // and decay ethPerFeeAsset by MAX_FEE_ASSET_PRICE_MODIFIER_BPS per slot for conservative estimates.
  // Lower ethPerFeeAsset means higher fees in fee asset terms.
  for (let i = 1; i < state.l1FeesBySlot.length; i++) {
    excessMana = computeExcessMana(excessMana, assumedManaUsed, state.manaTarget);
    const decayed = (ethPerFeeAsset * (10000n - MAX_FEE_ASSET_PRICE_MODIFIER_BPS)) / 10000n;
    ethPerFeeAsset = decayed < MIN_ETH_PER_FEE_ASSET ? MIN_ETH_PER_FEE_ASSET : decayed;
    result.push(computeGasFees(state, excessMana, ethPerFeeAsset, state.l1FeesBySlot[i]));
  }

  return result;
}

function getAssumedManaUsed(state: FeeOracleState, manaUsage: ManaUsageEstimate): bigint {
  switch (manaUsage) {
    case ManaUsageEstimate.None:
      return 0n;
    case ManaUsageEstimate.Target:
      return state.manaTarget;
    case ManaUsageEstimate.Limit:
      return state.manaLimit;
  }
}

function computeGasFees(state: FeeOracleState, excessMana: bigint, ethPerFeeAsset: bigint, l1Fees: L1FeeData): GasFees {
  return new GasFees(
    0,
    computeManaMinFee({
      l1BaseFee: l1Fees.baseFee,
      l1BlobFee: l1Fees.blobFee,
      manaTarget: state.manaTarget,
      epochDuration: state.epochDuration,
      provingCostPerManaEth: state.provingCostPerManaEth,
      excessMana,
      ethPerFeeAsset,
      protocolFeeMarginBps: state.protocolFeeMarginBps,
    }),
  );
}
