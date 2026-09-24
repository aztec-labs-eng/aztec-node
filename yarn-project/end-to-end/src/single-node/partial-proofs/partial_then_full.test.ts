import type { Logger } from '@aztec-labs/aztec.js/log';
import type { RollupContract } from '@aztec-labs/ethereum/contracts';
import { CheckpointNumber, type EpochNumber } from '@aztec-labs/foundation/branded-types';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { retryUntil } from '@aztec-labs/foundation/retry';
import type { TestProverNode } from '@aztec-labs/prover-node/test';
import { expect } from '@jest/globals';

import { PROVING_SLOT_TIMING, SingleNodeTestContext, jest, setupWithProver } from './setup.js';

// Suite: a partial proof that is still proving when its epoch ends must not conflict with the full epoch proof.
// The partial session is held at `beforeTopTreeProve` while the epoch ends, so the full session opens beside it.
// The full proof publishes first. The released partial then ends below the proven tip, so the publishing queue
// supersedes it without an L1 send. Timing: ethSlot=4s, aztecSlot=12s, epoch=6, fake prover. proofSubmissionEpochs
// is 2 so the epoch's submission window stays open across the whole sequence.
describe('single-node/partial-proofs/partial_then_full', () => {
  let test: SingleNodeTestContext;
  let logger: Logger;
  let rollup: RollupContract;

  beforeEach(async () => {
    test = await setupWithProver({ startProverNode: false, aztecProofSubmissionEpochs: 2, ...PROVING_SLOT_TIMING });
    ({ logger, rollup } = test);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await test.teardown();
  });

  it('publishes the full epoch proof while a partial proof of the same epoch is in progress', async () => {
    const prover = (await test.createProverNode({ dontStart: true })).getProverNode()! as TestProverNode;
    // Session hooks can only be installed on a started prover node, since the session manager is created in start().
    await prover.start();

    const gate = promiseWithResolvers<void>();
    let gatedPartial: ReturnType<TestProverNode['sessionManager']['allSessions']>[number] | undefined;
    prover.setSessionHooks({
      beforeTopTreeProve: async () => {
        // The hook takes no session argument, so identify the caller by state: `EpochSession` flips to
        // `awaiting-root` before awaiting this hook. Hold only the first partial caller. The full session reaches
        // this hook while the partial is still held, so every later caller must pass through.
        if (gatedPartial) {
          return;
        }
        const session = prover.sessionManager
          .allSessions()
          .find(s => s.getKind() === 'partial' && s.getState() === 'awaiting-root');
        if (!session) {
          return;
        }
        gatedPartial = session;
        await gate.promise;
      },
    });

    // Start the partial proof while its epoch is still in progress, so no full session for it exists yet.
    const epoch: EpochNumber = await retryUntil(
      async () => {
        const current = await rollup.getCurrentEpoch();
        const tip = await rollup.getCheckpointNumber();
        return tip > 0 && (await rollup.getEpochNumberForCheckpoint(tip)) === current ? current : undefined;
      },
      'a checkpoint in the current epoch',
      test.L2_SLOT_DURATION_IN_S * 12,
      0.5,
    );
    // `startProof` throws until the prover node has synced a checkpoint of the epoch.
    await retryUntil(
      async () => {
        try {
          await prover.startProof(epoch);
          return true;
        } catch (err) {
          logger.verbose(`Cannot start partial proof of epoch ${epoch} yet: ${err}`);
          return false;
        }
      },
      `prover starts a partial proof of epoch ${epoch}`,
      test.L2_SLOT_DURATION_IN_S * 6,
      1,
    );

    const partial = await retryUntil(
      () => Promise.resolve(gatedPartial),
      'partial session blocks at the proving gate',
      test.L2_SLOT_DURATION_IN_S * 6,
      0.5,
    );
    expect(partial.getEpochNumber()).toEqual(epoch);

    const full = await retryUntil(
      () => Promise.resolve(prover.sessionManager.getFullSession(epoch)),
      `full session opens for epoch ${epoch}`,
      test.L2_SLOT_DURATION_IN_S * 12,
      0.5,
    );
    expect(partial.getState()).toEqual('awaiting-root');

    const checkpoints = full.getCheckpoints();
    const lastCheckpoint = CheckpointNumber(checkpoints[checkpoints.length - 1].checkpoint.number);
    logger.info(`Full session opened for epoch ${epoch} while the partial proof is held`, { epoch, lastCheckpoint });

    await test.waitUntilProvenCheckpointNumber(lastCheckpoint, test.L2_SLOT_DURATION_IN_S * 12);
    await expect(full.whenDone()).resolves.toEqual('completed');

    logger.info(`Releasing the partial proof with the tip at ${test.monitor.provenCheckpointNumber}`);
    gate.resolve();

    await expect(partial.whenDone()).resolves.toEqual('superseded');
    expect(await rollup.getProvenCheckpointNumber()).toBeGreaterThanOrEqual(lastCheckpoint);
  });
});
