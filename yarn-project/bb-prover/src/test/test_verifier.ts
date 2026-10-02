import { ProofVerifierUnavailableError } from '@aztec-labs/stdlib/errors';
import type { ClientProtocolCircuitVerifier, IVCProofVerificationResult } from '@aztec-labs/stdlib/interfaces/server';
import type { Tx } from '@aztec-labs/stdlib/tx';

/** How a {@link TestCircuitVerifier} answers: accept the proof, reject it, or fail to check it. */
export type TestVerifierOutcome = 'valid' | 'invalid' | 'unavailable';

export class TestCircuitVerifier implements ClientProtocolCircuitVerifier {
  /** What every subsequent verification answers. Accepts every proof unless changed. */
  public outcome: TestVerifierOutcome = 'valid';

  constructor(private verificationDelayMs?: number) {}

  async verifyProof(_tx: Tx): Promise<IVCProofVerificationResult> {
    const durationMs = this.verificationDelayMs ?? 0;
    if (durationMs > 0) {
      await new Promise(resolve => setTimeout(resolve, durationMs));
    }
    if (this.outcome === 'unavailable') {
      throw new ProofVerifierUnavailableError('TestCircuitVerifier is unavailable');
    }
    return { valid: this.outcome === 'valid', durationMs, totalDurationMs: durationMs };
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }
}
