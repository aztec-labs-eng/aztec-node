import { IndexWithinCheckpoint } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { BlockProposal, CheckpointProposal } from '@aztec-labs/stdlib/p2p';
import { computeBlockHeadersHash } from '@aztec-labs/stdlib/rollup';
import {
  makeBlockHeader,
  makeBlockProposal,
  makeCheckpointHeader,
  makeCheckpointProposal,
} from '@aztec-labs/stdlib/testing';
import { describe, expect, it } from '@jest/globals';

import { type InvalidBlockVerdict, checkpointCommitsToRejectedBlock } from './invalid_checkpoint_evidence.js';

// Builds `count` committed block proposals (indices 0..count-1), the last carrying `checkpointArchive`, plus a
// checkpoint whose signed blockHeadersHash is computed over exactly those headers.
async function makeCommittedCheckpoint(
  count: number,
): Promise<{ checkpoint: CheckpointProposal; proposals: BlockProposal[] }> {
  const checkpointArchive = Fr.random();
  const proposals: BlockProposal[] = [];
  for (let i = 0; i < count; i++) {
    const blockHeader = makeBlockHeader(i + 1);
    const archiveRoot = i === count - 1 ? checkpointArchive : Fr.random();
    proposals.push(
      await makeBlockProposal({ blockHeader, indexWithinCheckpoint: IndexWithinCheckpoint(i), archiveRoot }),
    );
  }
  const checkpointHeader = makeCheckpointHeader(1);
  checkpointHeader.blockHeadersHash = await computeBlockHeadersHash(proposals.map(p => p.blockHeader));
  const checkpoint = await makeCheckpointProposal({ checkpointHeader, archiveRoot: checkpointArchive });
  return { checkpoint, proposals };
}

function headerMismatchVerdict(proposal: BlockProposal): InvalidBlockVerdict {
  return {
    blockHeader: proposal.blockHeader,
    archiveRoot: proposal.archiveRoot,
    headerMismatch: true,
    archiveMismatch: false,
  };
}

describe('checkpointCommitsToRejectedBlock', () => {
  it('binds a header-mismatch block that is in the verified committed sequence', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    expect(await checkpointCommitsToRejectedBlock(checkpoint, proposals, [headerMismatchVerdict(proposals[1])])).toBe(
      true,
    );
  });

  it('does not bind a rejected block outside the committed sequence (an extra n+1 block)', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    const extra = await makeBlockProposal({
      blockHeader: makeBlockHeader(99),
      indexWithinCheckpoint: IndexWithinCheckpoint(3),
      archiveRoot: Fr.random(),
    });
    expect(
      await checkpointCommitsToRejectedBlock(checkpoint, [...proposals, extra], [headerMismatchVerdict(extra)]),
    ).toBe(false);
  });

  it('does not bind an archive-claim mismatch for an archive the checkpoint does not sign', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    const rejected = proposals[1];
    expect(rejected.archiveRoot.equals(checkpoint.archive)).toBe(false);
    const verdict: InvalidBlockVerdict = {
      blockHeader: rejected.blockHeader,
      archiveRoot: rejected.archiveRoot,
      headerMismatch: false,
      archiveMismatch: true,
    };
    expect(await checkpointCommitsToRejectedBlock(checkpoint, proposals, [verdict])).toBe(false);
  });

  it('binds an archive-mismatch block that is the committed sequence last and claims the signed archive', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    const last = proposals[2];
    expect(last.archiveRoot.equals(checkpoint.archive)).toBe(true);
    const verdict: InvalidBlockVerdict = {
      blockHeader: last.blockHeader,
      archiveRoot: last.archiveRoot,
      headerMismatch: false,
      archiveMismatch: true,
    };
    expect(await checkpointCommitsToRejectedBlock(checkpoint, proposals, [verdict])).toBe(true);
  });

  it('does not bind an extra n+1 block whose archive claim equals the signed archive', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    // An extra block past the committed sequence that claims the checkpoint's signed archive is not the sequence's
    // last block, so a stale verdict for it must not slash the valid checkpoint's signers.
    const extra = await makeBlockProposal({
      blockHeader: makeBlockHeader(99),
      indexWithinCheckpoint: IndexWithinCheckpoint(3),
      archiveRoot: checkpoint.archive,
    });
    const verdict: InvalidBlockVerdict = {
      blockHeader: extra.blockHeader,
      archiveRoot: checkpoint.archive,
      headerMismatch: false,
      archiveMismatch: true,
    };
    expect(await checkpointCommitsToRejectedBlock(checkpoint, [...proposals, extra], [verdict])).toBe(false);
  });

  it('does not bind when a committed proposal is missing so the sequence cannot be reconstructed', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    const retained = proposals.filter((_, i) => i !== 0);
    expect(await checkpointCommitsToRejectedBlock(checkpoint, retained, [headerMismatchVerdict(proposals[1])])).toBe(
      false,
    );
  });

  it('does not bind with no verdicts', async () => {
    const { checkpoint, proposals } = await makeCommittedCheckpoint(3);
    expect(await checkpointCommitsToRejectedBlock(checkpoint, proposals, [])).toBe(false);
  });
});
