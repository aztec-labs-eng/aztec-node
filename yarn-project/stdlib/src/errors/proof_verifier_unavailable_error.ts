/**
 * Thrown by a `ClientProtocolCircuitVerifier` when it could not check a proof, so the proof was neither
 * accepted nor rejected. Callers must not treat it as a verdict on the proof or on whoever sent it.
 */
export class ProofVerifierUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProofVerifierUnavailableError';
  }
}
