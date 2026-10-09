import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { ProofVerifierUnavailableError } from '@aztec-labs/stdlib/errors';
import type { IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import { mockTx } from '@aztec-labs/stdlib/testing';
import type { Tx } from '@aztec-labs/stdlib/tx';

import { type FailingChonkVerifier, SelfHealingChonkVerifier } from './self_healing_chonk_verifier.js';

/** Stands in for a BatchChonkVerifier: verifies everything until failed, then rejects everything as unavailable. */
class FakeVerifier implements FailingChonkVerifier {
  public failed = false;
  public verifications = 0;
  public stops = 0;

  public verifyProof(): Promise<IVCProofVerificationResult> {
    if (this.failed) {
      return Promise.reject(new ProofVerifierUnavailableError('fake verifier failed'));
    }
    this.verifications++;
    return Promise.resolve({ valid: true, durationMs: 1, totalDurationMs: 1 });
  }

  public isFailed(): boolean {
    return this.failed;
  }

  public stop(): Promise<void> {
    this.stops++;
    return Promise.resolve();
  }
}

describe('SelfHealingChonkVerifier', () => {
  let tx: Tx;
  let first: FakeVerifier;
  let created: FakeVerifier[];
  let create: () => Promise<FakeVerifier>;

  beforeEach(async () => {
    tx = await mockTx();
    first = new FakeVerifier();
    created = [];
    create = () => {
      const verifier = new FakeVerifier();
      created.push(verifier);
      return Promise.resolve(verifier);
    };
  });

  it('sends verifications to the verifier while it is healthy', async () => {
    const verifier = new SelfHealingChonkVerifier(create, first, 'test');
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(first.verifications).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('replaces a failed verifier on the next verification, and stops the failed one', async () => {
    const verifier = new SelfHealingChonkVerifier(create, first, 'test');
    first.failed = true;

    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(created).toHaveLength(1);
    expect(created[0].verifications).toBe(1);
    expect(first.stops).toBe(1);
  });

  it('starts one replacement however many verifications find the verifier failed', async () => {
    const verifier = new SelfHealingChonkVerifier(create, first, 'test');
    first.failed = true;

    const results = await Promise.all([1, 2, 3].map(() => verifier.verifyProof(tx)));
    expect(results.every(r => r.valid)).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('reports the verifier unavailable when a replacement cannot be started, and tries again after the interval', async () => {
    let failCreate = true;
    const flaky = () => (failCreate ? Promise.reject(new Error('bb would not start')) : create());
    const verifier = new SelfHealingChonkVerifier(flaky, first, 'test', 60_000);
    first.failed = true;

    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    // Within the interval, no new attempt is made, even once bb would start.
    failCreate = false;
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    expect(created).toHaveLength(0);

    const eager = new SelfHealingChonkVerifier(flaky, first, 'test', 0);
    await expect(eager.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(created).toHaveLength(1);
  });

  it('stops the verifier in use', async () => {
    const verifier = new SelfHealingChonkVerifier(create, first, 'test');
    await verifier.stop();
    expect(first.stops).toBe(1);
    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
  });

  it('does not wait for a replacement still starting when stopped; the replacement stops itself when ready', async () => {
    const replacement = new FakeVerifier();
    const start = promiseWithResolvers<FakeVerifier>();
    const verifier = new SelfHealingChonkVerifier(() => start.promise, first, 'test');
    first.failed = true;
    const verification = verifier.verifyProof(tx);
    // Let the verification find the verifier failed and start its replacement.
    await new Promise(resolve => setImmediate(resolve));

    await verifier.stop();
    expect(replacement.stops).toBe(0);

    start.resolve(replacement);
    await expect(verification).rejects.toBeInstanceOf(ProofVerifierUnavailableError);
    expect(replacement.stops).toBe(1);
    expect(replacement.verifications).toBe(0);
  });
});
