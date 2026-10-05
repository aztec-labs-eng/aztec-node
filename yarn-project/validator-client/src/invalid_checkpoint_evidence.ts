import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { BlockProposal, CheckpointProposalCore } from '@aztec-labs/stdlib/p2p';
import { computeBlockHeadersHash } from '@aztec-labs/stdlib/rollup';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

/**
 * A block proposal this node rejected, with the facts needed to decide whether that rejection is bound to a
 * checkpoint's signed payload. `headerMismatch`: the proposer's block header did not match re-execution, and the
 * checkpoint's blockHeadersHash commits to the header, so a header this node rejected that sits in the committed
 * sequence is proven invalid. `archiveMismatch`: the proposer's claimed resulting archive did not match
 * re-execution; it only binds to a checkpoint when it equals the checkpoint's signed archive.
 */
export type InvalidBlockVerdict = {
  blockHeader: BlockHeader;
  archiveRoot: Fr;
  headerMismatch: boolean;
  archiveMismatch: boolean;
};

/**
 * Whether `checkpoint` provably commits, in the payload its attesters signed, to a block this node rejected for a
 * reason the payload commits to.
 *
 * Missing evidence is never guilt: the committed block-header sequence is reconstructed from the slot's `retained`
 * block proposals and only trusted when `computeBlockHeadersHash` over it equals the signed `blockHeadersHash`. If
 * the sequence cannot be reconstructed (a committed proposal is not retained, or the prefix is not contiguous) or
 * the recomputed hash does not match, this returns false. A rejected block then binds only when its header is in
 * that verified sequence (header mismatch), or its claimed archive equals the checkpoint's signed archive (archive
 * mismatch). A wrong claim for an archive the checkpoint does not sign proves nothing about the checkpoint.
 */
export async function checkpointCommitsToRejectedBlock(
  checkpoint: CheckpointProposalCore,
  retained: BlockProposal[],
  verdicts: InvalidBlockVerdict[],
): Promise<boolean> {
  if (verdicts.length === 0) {
    return false;
  }
  const byIndex = [...retained].sort((a, b) => Number(a.indexWithinCheckpoint) - Number(b.indexWithinCheckpoint));
  const sequence: BlockProposal[] = [];
  for (let i = 0; i < byIndex.length; i++) {
    if (Number(byIndex[i].indexWithinCheckpoint) !== i) {
      // A gap in the committed prefix: the sequence cannot be reconstructed, so no evidence.
      return false;
    }
    sequence.push(byIndex[i]);
    if (byIndex[i].archiveRoot.equals(checkpoint.archive)) {
      const headers = sequence.map(p => p.blockHeader);
      const reconstructed = await computeBlockHeadersHash(headers);
      if (!reconstructed.equals(checkpoint.checkpointHeader.blockHeadersHash)) {
        // The retained proposals do not reconstruct the signed sequence, so the evidence is not bound.
        return false;
      }
      for (const v of verdicts) {
        if (v.headerMismatch && sequence.some(p => p.blockHeader.equals(v.blockHeader))) {
          return true;
        }
        if (v.archiveMismatch && v.archiveRoot.equals(checkpoint.archive)) {
          return true;
        }
      }
      return false;
    }
  }
  // The signed archive names no block in the contiguous retained prefix, so the sequence is not reconstructed.
  return false;
}
