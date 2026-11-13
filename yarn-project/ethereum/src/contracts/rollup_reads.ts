import { RollupAbi } from '@aztec-foundation/l1-artifacts/RollupAbi';

import { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';
import { Buffer32 } from '@aztec-labs/foundation/buffer';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType } from 'viem';

import type { CheckpointLog, L1FeeData } from './rollup.js';

type RollupViewName = ContractFunctionName<typeof RollupAbi, 'pure' | 'view'>;
type RollupViewArgs<F extends RollupViewName> = ContractFunctionArgs<typeof RollupAbi, 'pure' | 'view', F>;
type RollupViewResult<F extends RollupViewName> = ContractFunctionReturnType<typeof RollupAbi, 'pure' | 'view', F>;

/** One rollup view call, so that several can be sent to L1 together in a single Multicall3 `aggregate3`. */
export type RollupRead<T> = {
  /** The function and its arguments. Two reads with the same key return the same value at a given L1 block. */
  readonly key: string;
  readonly functionName: RollupViewName;
  readonly args: readonly unknown[];
  /** Turns the ABI-decoded result into the value callers use. */
  readonly parse: (result: unknown) => T;
};

/** How one read of a batch came back: its ABI-decoded result, or the error it reverted with. */
export type RollupReadOutcome = { ok: true; result: unknown } | { ok: false; error: Error };

/** The outcomes of a batch of reads, by {@link RollupRead.key}. */
export type RollupReadOutcomes = Map<string, RollupReadOutcome>;

function makeRead<F extends RollupViewName, T>(
  functionName: F,
  args: RollupViewArgs<F>,
  parse: (result: RollupViewResult<F>) => T,
): RollupRead<T> {
  const argList: readonly unknown[] = Array.isArray(args) ? args : [];
  return {
    key: `${functionName}(${argList.map(String).join(',')})`,
    functionName,
    args: argList,
    // Multicall decodes each result against the ABI entry of its function name, so the shape matches `F`.
    parse: result => parse(result as RollupViewResult<F>),
  };
}

/** Converts the rollup's `getCheckpoint` result into a {@link CheckpointLog}. */
export function toCheckpointLog(result: RollupViewResult<'getCheckpoint'>): CheckpointLog {
  return {
    archive: Fr.fromString(result.archive),
    headerHash: Buffer32.fromString(result.headerHash),
    blobCommitmentsHash: Buffer32.fromString(result.blobCommitmentsHash),
    attestationsHash: Buffer32.fromString(result.attestationsHash),
    payloadDigest: Buffer32.fromString(result.payloadDigest),
    slotNumber: SlotNumber.fromBigInt(result.slotNumber),
    feeHeader: {
      excessMana: result.feeHeader.excessMana,
      manaUsed: result.feeHeader.manaUsed,
      ethPerFeeAsset: result.feeHeader.ethPerFeeAsset,
      protocolFee: result.feeHeader.protocolFee,
      proverCost: result.feeHeader.proverCost,
    },
  };
}

/** Rollup reads that can be batched with {@link RollupContract.readBatch}. */
export const rollupReads = {
  tips: () =>
    makeRead('getTips', [], tips => ({
      pending: CheckpointNumber.fromBigInt(tips.pending),
      proven: CheckpointNumber.fromBigInt(tips.proven),
    })),
  currentSlot: () => makeRead('getCurrentSlot', [], slot => SlotNumber.fromBigInt(slot)),
  manaTarget: () => makeRead('getManaTarget', [], target => target),
  provingCostPerManaInEth: () => makeRead('getProvingCostPerManaInEth', [], cost => cost),
  protocolFeeMargin: () => makeRead('getProtocolFeeMargin', [], margin => BigInt(margin)),
  checkpoint: (checkpointNumber: CheckpointNumber) =>
    makeRead('getCheckpoint', [BigInt(checkpointNumber)], toCheckpointLog),
  canPruneAtTime: (timestamp: bigint) => makeRead('canPruneAtTime', [timestamp], canPrune => canPrune),
  /** The mana min fee at `timestamp`, in fee asset. */
  manaMinFeeAt: (timestamp: bigint) => makeRead('getManaMinFeeAt', [timestamp, true], fee => fee),
  l1FeesAt: (timestamp: bigint) =>
    makeRead('getL1FeesAt', [timestamp], (fees): L1FeeData => ({ baseFee: fees.baseFee, blobFee: fees.blobFee })),
};

/**
 * The value of `read` among `outcomes`: undefined when the batch did not include it, and its error thrown when it
 * reverted.
 */
export function getReadValue<T>(outcomes: RollupReadOutcomes, read: RollupRead<T>): T | undefined {
  const outcome = outcomes.get(read.key);
  if (outcome === undefined) {
    return undefined;
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return read.parse(outcome.result);
}
