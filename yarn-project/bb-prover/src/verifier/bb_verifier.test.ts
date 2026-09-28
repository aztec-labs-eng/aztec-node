import { createLogger } from '@aztec-labs/foundation/log';
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

  it('waits for a bb instance to start rather than rejecting the proof', async () => {
    factory.planNextInstance(new Error('spawn failed'));
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
  });

  it('reports the verifier unavailable when a per-call bb instance cannot be started', async () => {
    const perCallFactory = new FakeBBJsFactory();
    perCallFactory.planNextInstance(new Error('spawn failed'));
    const perCallVerifier = new TestBBCircuitVerifier(perCallFactory);
    await expect(perCallVerifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('stops a queued verifier while a verification waits for a bb instance that never starts', async () => {
    factory.planNextInstance([], new Promise<void>(() => {}));
    const queued = new QueuedIVCVerifier(verifier, 1);
    const verificationFails = expect(queued.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    // Let the verification start waiting for the pool before stopping.
    await new Promise(resolve => setImmediate(resolve));

    await queued.stop();
    await verificationFails;
  });
});
