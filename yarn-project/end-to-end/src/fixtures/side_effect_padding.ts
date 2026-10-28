import type { SideEffectCounts, TxSideEffectCounts } from '@aztec-labs/pxe/server';

/** Adds `paddingPerPhase` items to each kind of side effect, in each phase of the tx. */
export function padSideEffectCounts(counts: TxSideEffectCounts, paddingPerPhase: number): TxSideEffectCounts {
  const padPhase = (phase: SideEffectCounts): SideEffectCounts => ({
    noteHashes: phase.noteHashes + paddingPerPhase,
    nullifiers: phase.nullifiers + paddingPerPhase,
    privateLogs: phase.privateLogs + paddingPerPhase,
  });

  return counts.isPrivateOnlyTx
    ? { isPrivateOnlyTx: true, ...padPhase(counts) }
    : {
        isPrivateOnlyTx: false,
        nonRevertible: padPhase(counts.nonRevertible),
        revertible: padPhase(counts.revertible),
      };
}
