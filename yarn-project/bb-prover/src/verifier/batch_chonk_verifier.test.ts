import { isBatchVerifierInternalError } from './batch_chonk_verifier.js';

describe('isBatchVerifierInternalError', () => {
  // Messages bb's batch verifier formats from an exception it caught.
  it.each([
    'reduce_to_triple_ipa_opening threw: std::bad_alloc',
    'reduce_to_triple_ipa_opening threw unknown exception',
    'ChonkBatchVerifier: result callback threw: broken pipe',
  ])('classifies %s as an internal error', message => {
    expect(isBatchVerifierInternalError(message)).toBe(true);
  });

  // Messages for a proof bb checked and rejected.
  it.each([
    'reduction failed',
    'ChonkVerifier: verification failed at IPA check',
    'IPA batch verification failed: combined G_0 mismatch',
    '',
    undefined,
  ])('classifies %s as a rejected proof', message => {
    expect(isBatchVerifierInternalError(message)).toBe(false);
  });
});
