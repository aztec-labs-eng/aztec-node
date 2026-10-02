import { ProofVerifierUnavailableError } from '@aztec-labs/stdlib/errors';
import type { ClientProtocolCircuitVerifier } from '@aztec-labs/stdlib/interfaces/server';
import { mockTx } from '@aztec-labs/stdlib/testing';
import { TX_ERROR_INVALID_PROOF, TX_ERROR_PROOF_UNVERIFIABLE, type Tx } from '@aztec-labs/stdlib/tx';
import { type MockProxy, mock } from 'jest-mock-extended';

import { TxProofValidator } from './tx_proof_validator.js';

describe('TxProofValidator', () => {
  let verifier: MockProxy<ClientProtocolCircuitVerifier>;
  let validator: TxProofValidator;
  let tx: Tx;

  beforeEach(async () => {
    verifier = mock<ClientProtocolCircuitVerifier>();
    validator = new TxProofValidator(verifier);
    tx = await mockTx();
  });

  it('accepts a proof the verifier accepts', async () => {
    verifier.verifyProof.mockResolvedValue({ valid: true, durationMs: 1, totalDurationMs: 1 });
    await expect(validator.validateTx(tx)).resolves.toEqual({ result: 'valid' });
  });

  it('rejects a proof the verifier checked and rejected', async () => {
    verifier.verifyProof.mockResolvedValue({ valid: false, durationMs: 1, totalDurationMs: 1 });
    await expect(validator.validateTx(tx)).resolves.toEqual({ result: 'invalid', reason: [TX_ERROR_INVALID_PROOF] });
  });

  it('reports the proof unverifiable when the verifier is unavailable', async () => {
    verifier.verifyProof.mockRejectedValue(new ProofVerifierUnavailableError('bb is down'));
    await expect(validator.validateTx(tx)).resolves.toEqual({
      result: 'unverifiable',
      reason: [TX_ERROR_PROOF_UNVERIFIABLE],
    });
  });

  it('reports the proof unverifiable when the verifier fails unexpectedly', async () => {
    verifier.verifyProof.mockRejectedValue(new Error('unexpected'));
    await expect(validator.validateTx(tx)).resolves.toEqual({
      result: 'unverifiable',
      reason: [TX_ERROR_PROOF_UNVERIFIABLE],
    });
  });
});
