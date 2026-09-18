import type { AztecNode } from '@aztec-labs/aztec.js/node';
import type { Logger } from '@aztec-labs/foundation/log';
import { retryUntil } from '@aztec-labs/foundation/retry';
import { jest } from '@jest/globals';

import { PIPELINING_SETUP_OPTS } from '../../fixtures/fixtures.js';
import { setupBlockProducer } from '../setup.js';
import type { SingleNodeTestContext, SingleNodeTestOpts } from '../single_node_test_context.js';

// Covers `SingleNodeTestContext.advanceToNextEpochWithSequencersPaused`, the epoch warp the prover
// suites run between phases. Under pipelining there is normally a built-but-unpublished block in
// flight, and a live warp of a whole epoch moves its target slot into the past, so the archiver prunes
// it as an orphan. Both cases below run with the PXE on the checkpointed tip, which is what the prover
// fixture uses: the point of the second case is that checkpointed anchoring stays healthy even when
// publication has stopped, so only the explicit check catches it.
describe('single-node/sequencer/safe_epoch_warp', () => {
  jest.setTimeout(5 * 60 * 1000);

  let test: SingleNodeTestContext;
  let node: AztecNode;
  let logger: Logger;
  let watch: ReturnType<SingleNodeTestContext['watchSequencerEvents']> | undefined;

  const setupTest = async (opts: SingleNodeTestOpts = {}) => {
    test = await setupBlockProducer({
      ...PIPELINING_SETUP_OPTS,
      aztecEpochDuration: 6,
      pxeOpts: { syncChainTip: 'checkpointed' },
      ...opts,
    });
    ({ logger } = test.context);
    node = test.context.aztecNodeService;
  };

  /**
   * Resolves with the proposed tip once the chain has published at least one checkpoint and the next
   * block is in flight, so the scenario is a running chain rather than a chain that never started.
   */
  const waitForUnpublishedProposal = async () => {
    await retryUntil(
      async () => (await node.getChainTips()).checkpointed.block.number > 0,
      'the first published checkpoint',
      180,
      0.5,
    );
    return retryUntil(
      async () => {
        const tips = await node.getChainTips();
        return tips.proposed.number > tips.checkpointed.block.number ? tips.proposed : undefined;
      },
      'a proposed block that has not been checkpointed yet',
      180,
      0.2,
    );
  };

  afterEach(async () => {
    watch?.stop();
    watch = undefined;
    await test.teardown();
  });

  it('checkpoints an in-flight proposal before warping', async () => {
    await setupTest();

    const proposed = await waitForUnpublishedProposal();
    logger.info(`Advancing an epoch with block ${proposed.number} (${proposed.hash}) still unpublished`);

    watch = test.watchSequencerEvents(test.getSequencers(test.nodes));
    await test.advanceToNextEpochWithSequencersPaused(test.nodes, node, test.context.cheatCodes);
    test.assertNoFailuresFromSequencers(watch.failEvents);

    // The block that was in flight is still the block at that height — a prune would have removed it or
    // replaced it with the rebuild that took its slot — and its checkpoint reached L1.
    const data = await node.getBlockData(proposed.number);
    expect(data).toBeDefined();
    expect(data!.blockHash.toString()).toEqual(proposed.hash);
    expect(Number(data!.checkpointNumber)).toBeLessThanOrEqual(Number(await node.getCheckpointNumber('checkpointed')));
  });

  it('fails the advance when a proposal never reaches L1', async () => {
    // No speed-ups and no cancellation tx, so a dropped publication stays dropped rather than being
    // re-sent under a fresh nonce; the shortened timeout bounds how long the drain waits on it.
    await setupTest({ maxSpeedUpAttempts: 0, cancelTxOnTimeout: false, txTimeoutMs: 20_000 });

    await waitForUnpublishedProposal();

    // Drop the sequencer's next L1 tx and wait until one has actually been dropped. Arming alone is
    // racy: the in-flight proposal's tx may already have been broadcast, and pausing could then halt
    // the loop before any further tx is sent, leaving the delayer armed and nothing lost. This setup
    // runs with slashing off and no governance proposals, so the sequencer's only L1 tx is the
    // checkpoint proposal.
    const delayer = test.context.sequencerDelayer!;
    delayer.cancelNextTx();
    await retryUntil(() => delayer.getCancelledTxs().length > 0, 'the dropped checkpoint publication', 180, 0.1);

    await expect(
      test.advanceToNextEpochWithSequencersPaused(test.nodes, node, test.context.cheatCodes, { timeout: 30 }),
    ).rejects.toThrow(/Refusing to warp/);

    // Meanwhile the PXE reports nothing wrong: it anchors on the checkpointed tip, which simply stopped
    // moving, so it keeps syncing to a block that predates the dropped publication. That is the whole
    // point of asserting checkpoint health outright — anchoring cannot surface this on its own.
    await expect(test.context.wallet.sync()).resolves.not.toThrow();
    const header = await test.context.wallet.getSyncedBlockHeader();
    const checkpointedTip = (await node.getChainTips()).checkpointed.block.number;
    expect(Number(header.globalVariables.blockNumber)).toBeLessThanOrEqual(Number(checkpointedTip));
  });
});
