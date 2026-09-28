import { createLogger } from '@aztec-labs/foundation/log';
import { mockTx } from '@aztec-labs/stdlib/testing';
import type { Tx } from '@aztec-labs/stdlib/tx';

import type { BBJsFactory } from '../bb/bb_js_backend.js';
import type { BBConfig } from '../config.js';
import { FakeBBJsFactory } from '../test/fake_bb_js.js';
import { BBCircuitVerifier, ProofVerifierUnavailableError } from './bb_verifier.js';

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

  it('retries on a replacement instance when bb dies during verification', async () => {
    factory.planNextInstance(['die']);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(factory.created).toHaveLength(2);
    expect(factory.created[0].destroyCount).toBe(1);
  });

  it('reports the verifier unavailable, not the proof invalid, when bb dies on every attempt', async () => {
    factory.planNextInstance(['die']);
    factory.planNextInstance(['die']);
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('reports the verifier unavailable when no bb instance can be started', async () => {
    factory.planNextInstance(new Error('spawn failed'));
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('verifies again once a failed bb spawn succeeds', async () => {
    factory.planNextInstance(new Error('spawn failed'));
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
  });
});
