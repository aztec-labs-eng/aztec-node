import { createLogger } from '@aztec-labs/foundation/log';
import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { mockTx } from '@aztec-labs/stdlib/testing';
import type { Tx } from '@aztec-labs/stdlib/tx';

import type { BBJsFactory } from '../bb/bb_js_backend.js';
import type { BBConfig } from '../config.js';
import { FakeBBJsFactory } from '../test/fake_bb_js.js';
import { BBCircuitVerifier, ProofVerifierUnavailableError } from './bb_verifier.js';
import { QueuedIVCVerifier } from './queued_chonk_verifier.js';

const config: BBConfig = {
  bbBinaryPath: '/unused/bb',
  bbWorkingDirectory: '/unused/bb-working-directory',
  bbSkipCleanup: false,
  numConcurrentIVCVerifiers: 1,
  bbIVCConcurrency: 1,
  bbChonkVerifyMaxBatch: 1,
  bbChonkVerifyConcurrency: 1,
};

/** A BBCircuitVerifier over an injected bb.js factory. */
class TestBBCircuitVerifier extends BBCircuitVerifier {
  constructor(factory: BBJsFactory) {
    super(config, createLogger('bb-prover:verifier:test'), factory);
  }
}

describe('BBCircuitVerifier', () => {
  let factory: FakeBBJsFactory;
  let verifier: TestBBCircuitVerifier;
  let tx: Tx;

  beforeEach(async () => {
    factory = new FakeBBJsFactory(1);
    verifier = new TestBBCircuitVerifier(factory);
    tx = await mockTx();
  });

  afterEach(async () => {
    await verifier.stop();
  });

  it('accepts a proof bb verifies', async () => {
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
  });

  it('rejects a proof bb reports as not verified', async () => {
    factory.planNextInstance(['invalid']);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: false });
  });

  it('rejects a proof bb errors on while alive', async () => {
    factory.planNextInstance(['bb-error']);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: false });
    expect(factory.created).toHaveLength(1);
  });

  it('retries after bb dies during verification, on the replacement process', async () => {
    factory.planNextInstance(['die']);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    // The instance replaced its own bb process, so the pool neither grew nor lost a member.
    expect(factory.created).toHaveLength(1);
    expect(factory.created[0].chonkVerifyCalls).toBe(2);
    expect(factory.created[0].destroyCount).toBe(0);
  });

  it('reports the verifier unavailable, not the proof invalid, when bb dies on every attempt', async () => {
    factory.planNextInstance(['die', 'die']);
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('retries a failed spawn rather than rejecting the proof', async () => {
    factory.planNextInstance(new Error('spawn failed'));
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
  });

  it('reports the verifier unavailable when a per-call bb instance cannot be started', async () => {
    const perCallFactory = new FakeBBJsFactory();
    // A failed spawn is retried, so the instance must fail to start on every attempt.
    perCallFactory.planNextInstance(new Error('spawn failed'));
    perCallFactory.planNextInstance(new Error('spawn failed'));
    const perCallVerifier = new TestBBCircuitVerifier(perCallFactory);
    await expect(perCallVerifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('starts no more bb processes than the pool holds, however many verifications arrive', async () => {
    const results = await Promise.all([1, 2, 3].map(() => verifier.verifyProof(tx)));
    expect(results.every(r => r.valid)).toBe(true);
    expect(factory.created).toHaveLength(1);
  });

  it('stops a queued verifier while verifications wait on a bb instance that is still starting', async () => {
    // bb.js bounds how long a start can take; this one finishes only when the test lets it.
    const start = promiseWithResolvers<void>();
    factory.planNextInstance([], start.promise);
    const queued = new QueuedIVCVerifier(verifier, 2);
    const starting = expect(queued.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    const waiting = expect(queued.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    // Let one verification take the pool's only slot and the other queue for it.
    await new Promise(resolve => setImmediate(resolve));

    const stopping = queued.stop();
    // The verification waiting for a slot is released at once; the one starting bb, when the start ends.
    await waiting;
    start.resolve();
    await starting;
    await stopping;
    // The bb that finished starting after the stop was not left running.
    expect(factory.created[0].destroyCount).toBe(1);
  });
});
