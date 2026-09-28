import type { AvmStat } from '@aztec-foundation/bb.js';

import { type BBJsApi, BBJsFactory, type BBJsProofResult } from '../bb/bb_js_backend.js';

/** How a {@link FakeBBJsInstance} answers one `verifyChonkProof` call. */
export type FakeChonkVerifyOutcome = 'valid' | 'invalid' | 'bb-error' | 'die';

function notImplemented(): Promise<never> {
  return Promise.reject(new Error('Not implemented by FakeBBJsInstance'));
}

/** A {@link BBJsApi} double whose bb process can die. Only `verifyChonkProof` is implemented. */
export class FakeBBJsInstance implements BBJsApi {
  public destroyCount = 0;
  public chonkVerifyCalls = 0;
  private alive = true;

  /** @param outcomes - Answers to successive `verifyChonkProof` calls; `valid` once they run out. */
  constructor(private readonly outcomes: FakeChonkVerifyOutcome[] = []) {}

  /** Simulates the bb process dying: every later call fails as it does on a closed socket. */
  public kill(): void {
    this.alive = false;
  }

  public isAlive(): boolean {
    return this.alive;
  }

  public verifyChonkProof(): Promise<{ verified: boolean; durationMs: number }> {
    this.chonkVerifyCalls++;
    if (!this.alive) {
      return Promise.reject(new Error('Socket not connected'));
    }
    switch (this.outcomes.shift() ?? 'valid') {
      case 'valid':
        return Promise.resolve({ verified: true, durationMs: 1 });
      case 'invalid':
        return Promise.resolve({ verified: false, durationMs: 1 });
      case 'bb-error':
        return Promise.reject(new Error('bb rejected the proof input'));
      case 'die':
        this.kill();
        return Promise.reject(new Error('Socket connection ended unexpectedly'));
    }
  }

  public destroy(): Promise<void> {
    this.alive = false;
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

/** A pooled {@link BBJsFactory} that creates {@link FakeBBJsInstance}s instead of spawning bb. */
export class FakeBBJsFactory extends BBJsFactory {
  /** Every instance created, in creation order. */
  public readonly created: FakeBBJsInstance[] = [];
  private readonly plan: (FakeChonkVerifyOutcome[] | Error)[] = [];

  constructor(poolSize: number) {
    super('/unused/bb', { poolSize });
  }

  /** Scripts the next creation: an error makes that spawn fail, outcomes script the created instance's verifications. */
  public planNextInstance(next: FakeChonkVerifyOutcome[] | Error): void {
    this.plan.push(next);
  }

  protected override createInstance(): Promise<BBJsApi> {
    const next = this.plan.shift() ?? [];
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    const instance = new FakeBBJsInstance(next);
    this.created.push(instance);
    return Promise.resolve(instance);
  }
}
