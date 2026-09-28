import type { AvmStat } from '@aztec-foundation/bb.js';

import { type BBJsApi, BBJsFactory, type BBJsProofResult } from '../bb/bb_js_backend.js';

/** How a {@link FakeBBJsInstance} answers one `verifyChonkProof` call. */
export type FakeChonkVerifyOutcome = 'valid' | 'invalid' | 'bb-error' | 'die';

function notImplemented(): Promise<never> {
  return Promise.reject(new Error('Not implemented by FakeBBJsInstance'));
}

/** An error shaped like the one bb.js raises when the bb process died: retrying may help. */
function retryable(message: string): Error {
  return Object.assign(new Error(message), { retry: true });
}

/**
 * A {@link BBJsApi} double whose bb process can die.
 *
 * A pooled instance is created with respawn, so a death fails only the call that was in flight and
 * the next call is served by a replacement process. The double behaves the same way: `die` rejects
 * once, retryably, and leaves the instance usable. Only `verifyChonkProof` is implemented.
 */
export class FakeBBJsInstance implements BBJsApi {
  public destroyCount = 0;
  public chonkVerifyCalls = 0;
  private destroyed = false;

  /** @param outcomes - Answers to successive `verifyChonkProof` calls; `valid` once they run out. */
  constructor(private readonly outcomes: FakeChonkVerifyOutcome[] = []) {}

  public verifyChonkProof(): Promise<{ verified: boolean; durationMs: number }> {
    this.chonkVerifyCalls++;
    if (this.destroyed) {
      return Promise.reject(new Error('Backend connection closed'));
    }
    switch (this.outcomes.shift() ?? 'valid') {
      case 'valid':
        return Promise.resolve({ verified: true, durationMs: 1 });
      case 'invalid':
        return Promise.resolve({ verified: false, durationMs: 1 });
      case 'bb-error':
        return Promise.reject(new Error('bb rejected the proof input'));
      case 'die':
        return Promise.reject(retryable('Socket connection ended unexpectedly'));
    }
  }

  public destroy(): Promise<void> {
    this.destroyed = true;
    this.destroyCount++;
    return Promise.resolve();
  }

  public generateProof(): Promise<BBJsProofResult> {
    return notImplemented();
  }

  public verifyProof(): Promise<{ verified: boolean; durationMs: number }> {
    return notImplemented();
  }

  public computeGateCount(): Promise<{ circuitSize: number; durationMs: number }> {
    return notImplemented();
  }

  public generateContract(): Promise<{ solidityCode: string; durationMs: number }> {
    return notImplemented();
  }

  public generateAvmProof(): Promise<{ proof: Uint8Array[]; stats: AvmStat[]; durationMs: number }> {
    return notImplemented();
  }

  public verifyAvmProof(): Promise<{ verified: boolean; durationMs: number }> {
    return notImplemented();
  }

  public checkAvmCircuit(): Promise<{ passed: boolean; stats: AvmStat[]; durationMs: number }> {
    return notImplemented();
  }
}

/** A scripted {@link FakeBBJsFactory} spawn. */
type PlannedSpawn = {
  /** An error fails the spawn; outcomes script the created instance's verifications. */
  next: FakeChonkVerifyOutcome[] | Error;
  /** When set, the spawn completes only once it resolves. */
  spawned?: Promise<void>;
};

/** A {@link BBJsFactory} that creates {@link FakeBBJsInstance}s instead of spawning bb. */
export class FakeBBJsFactory extends BBJsFactory {
  /** Every instance created, in creation order. */
  public readonly created: FakeBBJsInstance[] = [];
  private readonly plan: PlannedSpawn[] = [];

  /** @param poolSize - Pooled instances to keep; when omitted, every borrow creates a fresh instance. */
  constructor(poolSize?: number) {
    super('/unused/bb', { poolSize });
  }

  /**
   * Scripts the next creation: an error makes that spawn fail, outcomes script the created instance's verifications.
   * With `spawned`, the spawn completes only once it resolves.
   */
  public planNextInstance(next: FakeChonkVerifyOutcome[] | Error, spawned?: Promise<void>): void {
    this.plan.push({ next, spawned });
  }

  protected override async createInstance(): Promise<BBJsApi> {
    const { next, spawned }: PlannedSpawn = this.plan.shift() ?? { next: [] };
    if (spawned) {
      await spawned;
    }
    if (next instanceof Error) {
      throw next;
    }
    const instance = new FakeBBJsInstance(next);
    this.created.push(instance);
    return instance;
  }
}
