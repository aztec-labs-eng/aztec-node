import type { Logger } from '@aztec-labs/aztec.js/log';
import { BlockNumber, CheckpointNumber } from '@aztec-labs/foundation/branded-types';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { sleep } from '@aztec-labs/foundation/sleep';
import { getEpochAtSlot } from '@aztec-labs/stdlib/epoch-helpers';
import { jest } from '@jest/globals';

import { testSpan } from '../../fixtures/timing.js';
import type { EndToEndContext } from '../../fixtures/utils.js';
import { PROVING_SLOT_TIMING, setupWithProver } from '../setup.js';
import { ARCHIVER_POLL_INTERVAL, SingleNodeTestContext } from '../single_node_test_context.js';

jest.setTimeout(1000 * 60 * 10);

// Suite: checks that multiple prover nodes can each submit their own valid proof for the same epoch.
// SingleNodeTestContext with startProverNode=false (test creates 3 prover nodes manually). Single
// sequencer node. Timing: ethSlot=4s, aztecSlot=12s (3 L1 slots), epoch=6, proofSubmissionEpochs=1,
// fake prover. Staggered top-tree-prove delays (patching createTopTreeOrchestrator's prove() per node)
// ensure provers don't all land at the same L1 block.
describe('single-node/proving/multi_proof', () => {
  let context: EndToEndContext;
  let logger: Logger;

  let test: SingleNodeTestContext;

  beforeEach(async () => {
    // Don't start prover node during setup - we'll create and manage all prover nodes in the test
    // This ensures we can apply delay patches before any prover starts proving.
    //
    // The per-prover stagger (`index * ethereumSlotDuration` ms) scales with the slot duration, so the
    // PROVING_SLOT_TIMING floor keeps the timeline short while holding the stagger >=1 L1 slot apart (the
    // three provers still land their proofs on distinct L1 blocks).
    test = await setupWithProver({
      startProverNode: false,
      ...PROVING_SLOT_TIMING,
    });
    ({ context, logger } = test);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await test.teardown();
  });

  // Creates 3 prover nodes (deferred start), patches each top tree's prove() to stagger by index *
  // ethereumSlotDuration (via createTopTreeOrchestrator; pre-v5 this patched finalizeEpoch), then starts
  // them all. Anchors on a freshly-started epoch (rather than epoch 0, which under CI load can be empty if
  // the node's sequencer comes up after the chain has already advanced past it), waits for that epoch to
  // elapse, then polls until all 3 provers have submitted proofs for it via rollup.getHasSubmittedProof.
  it('submits proofs from multiple prover-nodes', async () => {
    // Create all three prover nodes without starting them
    // This allows us to apply the delay patches before any proving begins
    await test.createProverNode({ dontStart: true });
    await test.createProverNode({ dontStart: true });
    await test.createProverNode({ dontStart: true });

    // Add a delay to prover nodes so not all txs land on the same place
    // We apply patches BEFORE starting the prover nodes to ensure all provers get the delay
    // This prevents the race condition where multiple provers submit to L1 at the same time
    test.proverNodes.forEach((proverAztecNode, index) => {
      const proverManager = proverAztecNode.getProverNode()!.getProver();
      const origCreateTopTree = proverManager.createTopTreeOrchestrator.bind(proverManager);
      proverManager.createTopTreeOrchestrator = () => {
        const topTree = origCreateTopTree();
        const origProve = topTree.prove.bind(topTree);
        topTree.prove = async (...args: Parameters<typeof origProve>) => {
          const result = await origProve(...args);
          const sleepTime = index * 1000 * test.constants.ethereumSlotDuration;
          logger.warn(`Delaying top-tree prove for prover node ${index} by ${sleepTime}ms`);
          await sleep(sleepTime);
          return result;
        };
        return topTree;
      };
    });

    // Now start all prover nodes after patches have been applied
    await Promise.all(test.proverNodes.map(node => node.getProverNode()!.start()));

    const proverIds = test.proverNodes.map(node => node.getProverNode()!.getProverId());
    logger.info(`Prover nodes running with ids ${proverIds.map(id => id.toString()).join(', ')}`);

    // Anchor on a freshly-started epoch with the provers already running, then warp past it so it fully
    // elapses. We can't use epoch 0: under CI load the sequencer can come up after the chain has already
    // advanced past epoch 0's slots, leaving it with no blocks, and the snapshot below would then have
    // nothing to read. Anchoring on the next epoch guarantees its full slot range is ahead of us.
    const epoch = await test.waitUntilNextEpochStarts();

    // Let the epoch produce a checkpoint before warping past it. `warpToEpochStart` discards the rest of
    // the epoch in L1 time, and a checkpoint the sequencer is still building when the warp lands is
    // re-targeted at a slot beyond it — so under load the anchored epoch can end with nothing published
    // for it at all, leaving the snapshot below nothing to read. An epoch that really produces nothing
    // fails here naming the epoch, rather than blaming the archiver further down.
    //
    // The budget has to outlast the last moment a checkpoint for this epoch can be observed. The clock
    // starts one L1 slot before the epoch opens (`waitUntilNextEpochStarts` returns on the block before
    // the boundary), the last block that can carry a `propose` for it sits one L1 slot before the next
    // boundary, and the archiver indexes that block some time after it is mined — so an epoch's worth of
    // slots alone would expire exactly as that last checkpoint lands, with nothing left for indexing it.
    await testSpan('wait:epoch-first-checkpoint', () =>
      retryUntil(
        async () => (await context.aztecNode.getCheckpointsData({ epoch })).length > 0 || undefined,
        `a checkpoint for epoch ${epoch} is indexed`,
        (test.epochDuration + 1) * test.L2_SLOT_DURATION_IN_S,
        0.5,
      ),
    );

    await test.warpToEpochStart(epoch + 1);

    // Snapshot the anchored epoch's checkpoints. The epoch is now closed on L1: the call above returns on
    // the first block it observes at or past one L1 slot before the boundary, so with blocks at least an L1
    // slot apart the next one is at or past the boundary itself, and anything still unmined for epoch N
    // reverts the slot check. The archiver, though, may still be catching up.
    // Read the authoritative L1 checkpoint tip, then wait until the archiver has indexed every checkpoint
    // up to it — only then is the epoch-N subset complete. Waiting on `length > 0` alone would race a
    // partial view and snapshot a prefix of the epoch, so it gates the complete view rather than replacing
    // the completeness check.
    const tip = (await test.monitor.run(true)).checkpointNumber;
    const checkpoints = await testSpan('wait:epoch-checkpoints-complete', () =>
      retryUntil(
        async () => {
          const all = await context.aztecNode.getCheckpointsData({ from: CheckpointNumber(1), limit: Number(tip) });
          if (all.length < Number(tip)) {
            return undefined;
          }
          const epochCheckpoints = all.filter(cp => getEpochAtSlot(cp.header.slotNumber, test.constants) === epoch);
          // `retryUntil` treats any truthy value as success, and an empty array is truthy: returning the
          // filter result directly would accept a complete view holding nothing for this epoch, and
          // `at(-1)!` below would then hand `undefined` to the caller. The wait before the warp is what
          // keeps the epoch non-empty; this only stops that footgun from reaching the non-null assertion.
          return epochCheckpoints.length > 0 ? epochCheckpoints : undefined;
        },
        `archiver indexes all checkpoints up to ${tip} for epoch ${epoch}`,
        test.L2_SLOT_DURATION_IN_S,
        0.5,
      ),
    );

    // `getHasSubmittedProof` is keyed by the number of checkpoints the epoch-root proof covers, so we
    // count checkpoints (not blocks). The epoch's last block is the last block of its final checkpoint.
    const epochCheckpointCount = checkpoints.length;
    const lastCheckpoint = checkpoints.at(-1)!;
    const epochLastBlockNum = BlockNumber(lastCheckpoint.startBlock + lastCheckpoint.blockCount - 1);
    logger.info(
      `Anchored on epoch ${epoch} with ${epochCheckpointCount} checkpoints up to L2 block ${epochLastBlockNum}`,
    );

    // Wait until all three provers have submitted proofs for the anchored epoch
    await test.waitForAllProversToSubmit(epoch, epochCheckpointCount);

    // That polls L1, while the assertion below reads the node, so give the archiver a window to index the
    // proof — a poll interval lost to CI load is otherwise enough to read the previous proven tip. Bounded
    // rather than `waitForNodeToSync`, which loops without a timeout. 200 archiver polls: an archiver that
    // has not indexed a mined event by then is stuck rather than slow, and a shorter wait also narrows the
    // window in which the next epoch's proof could land and overshoot the assertion below. The result is
    // boxed because `retryUntil` stops on any truthy value, and block number 0 is not truthy.
    const { proven: provenBlockNumber } = await testSpan('wait:proof-indexed', () =>
      retryUntil(
        async () => {
          const proven = await context.aztecNode.getBlockNumber('proven');
          return proven >= epochLastBlockNum ? { proven } : undefined;
        },
        `node indexes the proof for epoch ${epoch} up to block ${epochLastBlockNum}`,
        (ARCHIVER_POLL_INTERVAL * 200) / 1000,
        0.5,
      ),
    );

    // Still an equality check: the wait only rules out lag, so a proven tip past this epoch's last block —
    // a later epoch having been proven — fails here rather than passing as "at least far enough".
    expect(provenBlockNumber).toEqual(epochLastBlockNum);

    logger.info(`Test succeeded`);
  });
});
