import { promiseWithResolvers } from '@aztec-labs/foundation/promise';
import { sleep } from '@aztec-labs/foundation/sleep';
import type { IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import { ChonkProof } from '@aztec-labs/stdlib/proofs';
import { mockTx } from '@aztec-labs/stdlib/testing';
import type { Tx } from '@aztec-labs/stdlib/tx';

import { type FailingChonkVerifier, SelfHealingChonkVerifier } from './self_healing_chonk_verifier.js';

/** Txs whose proofs kill any fake verifier that checks them. */
const poisoned = new Set<string>();

/** Stands in for a BatchChonkVerifier: verifies everything until failed, then rejects everything. */
class FakeVerifier implements FailingChonkVerifier {
  public failed = false;
  public verifications = 0;
  public stops = 0;
  /** The next verification kills its bb: it fails with the proof in flight. */
  public dieOnNextVerification = false;
  /** The next verification is turned away while the verifier stays healthy. */
  public refuseNextVerification = false;
  /** How long a verification takes, and the most that were in flight at once. */
  public delayMs = 0;
  public maxInFlight = 0;
  private inFlight = 0;

  public async verifyProof(tx: Tx): Promise<IVCProofVerificationResult> {
    // Like BatchChonkVerifier, an empty proof is rejected without reaching bb.
    if (tx.chonkProof.fields.length === 0) {
      return { valid: false, durationMs: 0, totalDurationMs: 0 };
    }
    if (poisoned.has(tx.getTxHash().toString())) {
      this.dieOnNextVerification = true;
    }
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
      return await this.verifyNow();
    } finally {
      this.inFlight--;
    }
  }

  private verifyNow(): Promise<IVCProofVerificationResult> {
    if (this.dieOnNextVerification) {
      this.dieOnNextVerification = false;
      this.failed = true;
    }
    if (this.refuseNextVerification) {
      this.refuseNextVerification = false;
      return Promise.reject(new Error('fake verifier refused the proof'));
    }
    if (this.failed) {
      return Promise.reject(new Error('fake verifier failed'));
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

class ExitedError extends Error {}

describe('SelfHealingChonkVerifier', () => {
  let tx: Tx;
  let first: FakeVerifier;
  let created: FakeVerifier[];
  let create: () => Promise<FakeVerifier>;
  let exits: unknown[];
  const exitNode = (err: unknown): never => {
    exits.push(err);
    throw new ExitedError('exited');
  };
  const newVerifier = (factory: () => Promise<FakeVerifier>, replaceIntervalMs = 0) =>
    new SelfHealingChonkVerifier(factory, first, 'test', replaceIntervalMs, exitNode);

  beforeEach(async () => {
    tx = await mockTx();
    first = new FakeVerifier();
    created = [];
    exits = [];
    poisoned.clear();
    create = () => {
      const verifier = new FakeVerifier();
      created.push(verifier);
      return Promise.resolve(verifier);
    };
  });

  /** Creates verifiers that die on their first verification while `dying()` holds. */
  const dyingWhile = (dying: () => boolean) => () =>
    create().then(v => {
      v.dieOnNextVerification = dying();
      return v;
    });

  /** A proof bb gives a verdict on, as a healthy bb does between proofs that crash it. */
  const verdictOnAnotherProof = async (verifier: SelfHealingChonkVerifier, seed: number) =>
    expect(verifier.verifyProof(await mockTx(seed))).resolves.toMatchObject({ valid: true });

  it('sends verifications to the verifier while it is healthy', async () => {
    const verifier = newVerifier(create);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(first.verifications).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('replaces a failed verifier on the next verification, and stops the failed one', async () => {
    const verifier = newVerifier(create);
    first.failed = true;

    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(created).toHaveLength(1);
    expect(created[0].verifications).toBe(1);
    expect(first.stops).toBe(1);
  });

  it('starts one replacement however many verifications find the verifier failed', async () => {
    const verifier = newVerifier(create);
    first.failed = true;

    const results = await Promise.all([1, 2, 3].map(() => verifier.verifyProof(tx)));
    expect(results.every(r => r.valid)).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('checks a proof again, on the replacement, when its verifier dies with it in flight', async () => {
    const verifier = newVerifier(create);
    first.dieOnNextVerification = true;

    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(created).toHaveLength(1);
    expect(created[0].verifications).toBe(1);
  });

  it('checks each proof that was in flight when its verifier died on its own, one at a time', async () => {
    const verifier = newVerifier(create);
    first.delayMs = 20;
    const other = await mockTx(1);
    const both = Promise.all([verifier.verifyProof(tx), verifier.verifyProof(other)]);
    first.dieOnNextVerification = true;

    await expect(both).resolves.toMatchObject([{ valid: true }, { valid: true }]);
    expect(created).toHaveLength(1);
    expect(created[0].verifications).toBe(2);
    expect(created[0].maxInFlight).toBe(1);
  });

  it('holds back other proofs while one is checked on its own', async () => {
    const verifier = newVerifier(() =>
      create().then(v => {
        v.delayMs = 50;
        return v;
      }),
    );
    first.dieOnNextVerification = true;
    const onItsOwn = verifier.verifyProof(tx);
    while (created.length === 0) {
      await sleep(1);
    }

    const alongside = verifier.verifyProof(await mockTx(1));

    await expect(Promise.all([onItsOwn, alongside])).resolves.toMatchObject([{ valid: true }, { valid: true }]);
    expect(created[0].maxInFlight).toBe(1);
  });

  const poison = (t: Tx) => poisoned.add(t.getTxHash().toString());

  it('finds a proof invalid once its verifier has died checking it on its own', async () => {
    const verifier = newVerifier(create);
    await verdictOnAnotherProof(verifier, 1);
    poison(tx);

    await expect(verifier.verifyProof(tx)).resolves.toEqual({
      valid: false,
      durationMs: 0,
      totalDurationMs: expect.any(Number),
    });
  });

  it('answers a proof that crashed bb again without sending it to bb', async () => {
    const verifier = newVerifier(create);
    await verdictOnAnotherProof(verifier, 1);
    poison(tx);
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: false });
    const replacements = created.length;

    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: false });
    expect(created).toHaveLength(replacements);
  });

  it('answers a copy of a proof from the crash memo when the proof is blamed while the copy waits', async () => {
    const verifier = newVerifier(create);
    await verdictOnAnotherProof(verifier, 1);
    first.delayMs = 20;
    poison(tx);

    const copies = Promise.all([verifier.verifyProof(tx), verifier.verifyProof(tx)]);
    await sleep(100);

    // One replacement checks the first copy on its own and dies on it; the second copy never reaches bb.
    expect(created).toHaveLength(1);
    await expect(copies).resolves.toMatchObject([{ valid: false }, { valid: false }]);
  });

  it('does not blame a proof for a replacement that failed before the proof reached it', async () => {
    let replacements = 0;
    const verifier = newVerifier(() =>
      create().then(v => {
        v.failed = replacements++ === 0;
        return v;
      }),
    );
    await verdictOnAnotherProof(verifier, 1);
    first.dieOnNextVerification = true;

    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(created).toHaveLength(2);
  });

  it('blames no proof until bb has given a verdict on another since it last blamed one', async () => {
    const verifier = newVerifier(create);
    poison(tx);

    // bb has never given a verdict, so it may be bb that is broken: the proof waits.
    let settled = false;
    const waiting = verifier.verifyProof(tx).finally(() => (settled = true));
    await sleep(20);
    expect(settled).toBe(false);

    // Once bb gives a verdict on another proof, the waiting one is checked on its own again, and now blamed.
    await verdictOnAnotherProof(verifier, 1);
    await expect(waiting).resolves.toMatchObject({ valid: false });

    // Straight after a blame, the next proof that crashes bb waits again.
    const next = await mockTx(2);
    poison(next);
    settled = false;
    const waitingAgain = verifier.verifyProof(next).finally(() => (settled = true));
    await sleep(20);
    expect(settled).toBe(false);
    await verdictOnAnotherProof(verifier, 3);
    await expect(waitingAgain).resolves.toMatchObject({ valid: false });
  });

  it('does not count a proof rejected without reaching bb as bb giving a verdict', async () => {
    const verifier = newVerifier(create);
    poison(tx);
    const waiting = verifier.verifyProof(tx);
    await sleep(20);

    // A tx with no proof is rejected up front, so says nothing about whether bb works.
    const noProof = await mockTx(1, { chonkProof: ChonkProof.empty() });
    await expect(verifier.verifyProof(noProof)).resolves.toMatchObject({ valid: false });

    let settled = false;
    void waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(20);
    expect(settled).toBe(false);
    await verifier.stop();
    await expect(waiting).rejects.toThrow('stopped');
  });

  it('exits the node when no bb can be started to replace a failed one', async () => {
    const verifier = newVerifier(() => Promise.reject(new Error('bb would not start')));
    first.failed = true;

    await expect(verifier.verifyProof(tx)).rejects.toBeInstanceOf(ExitedError);
    expect(exits).toEqual([new Error('bb would not start')]);
  });

  it('does not retry a proof a healthy verifier turned away', async () => {
    const verifier = newVerifier(create);
    first.refuseNextVerification = true;

    await expect(verifier.verifyProof(tx)).rejects.toThrow('refused');
    expect(created).toHaveLength(0);
  });

  it('holds a verification that arrives while the verifier is down until the next replacement is due', async () => {
    const verifier = newVerifier(create, 200);
    first.failed = true;
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    created[0].failed = true;

    const startedAt = Date.now();
    await expect(verifier.verifyProof(tx)).resolves.toMatchObject({ valid: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(created).toHaveLength(2);
  });

  it('stops a verification waiting for the next replacement when the verifier stops', async () => {
    const verifier = newVerifier(
      dyingWhile(() => true),
      60_000,
    );
    first.failed = true;

    // Its replacement dies under it, so checking it on its own waits out the interval for the next one.
    const waiting = verifier.verifyProof(tx);
    await sleep(10);
    await verifier.stop();

    await expect(waiting).rejects.toThrow('stopped');
  });

  it('stops a verification waiting for bb to give a verdict when the verifier stops', async () => {
    const verifier = newVerifier(dyingWhile(() => true));
    first.dieOnNextVerification = true;
    const waiting = verifier.verifyProof(tx);
    await sleep(10);

    await verifier.stop();

    await expect(waiting).rejects.toThrow('stopped');
  });

  it('stops the verifier in use', async () => {
    const verifier = newVerifier(create);
    await verifier.stop();
    expect(first.stops).toBe(1);
    await expect(verifier.verifyProof(tx)).rejects.toThrow('stopped');
  });

  it('does not wait for a replacement still starting when stopped; the replacement stops itself when ready', async () => {
    const replacement = new FakeVerifier();
    const start = promiseWithResolvers<FakeVerifier>();
    const verifier = newVerifier(() => start.promise);
    first.failed = true;
    const verification = verifier.verifyProof(tx);
    // Let the verification find the verifier failed and start its replacement.
    await new Promise(resolve => setImmediate(resolve));

    await verifier.stop();
    expect(replacement.stops).toBe(0);

    start.resolve(replacement);
    await expect(verification).rejects.toThrow('stopped');
    expect(replacement.stops).toBe(1);
    expect(replacement.verifications).toBe(0);
  });
});
