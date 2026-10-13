import {
  TX_ERROR_DUPLICATE_NULLIFIER_IN_TX,
  TX_ERROR_EXISTING_NULLIFIER,
  TX_ERROR_INSUFFICIENT_FEE_PER_GAS,
  TX_ERROR_INVALID_EXPIRATION_TIMESTAMP,
  TX_ERROR_INVALID_PROOF,
  isReceiverLocalStateDrift,
} from './error_texts.js';

describe('isReceiverLocalStateDrift', () => {
  it('is true when every reason is receiver-local state drift', () => {
    expect(isReceiverLocalStateDrift([TX_ERROR_INVALID_EXPIRATION_TIMESTAMP])).toBe(true);
    expect(isReceiverLocalStateDrift([TX_ERROR_EXISTING_NULLIFIER, TX_ERROR_INVALID_EXPIRATION_TIMESTAMP])).toBe(true);
  });

  it('matches on prefix, so reasons that append detail still count (e.g. the fee reasons)', () => {
    expect(
      isReceiverLocalStateDrift([`${TX_ERROR_INSUFFICIENT_FEE_PER_GAS} (maxFee=da:1,l2:1 required=da:2,l2:2)`]),
    ).toBe(true);
  });

  it('is false when any reason is sender-attributable', () => {
    expect(isReceiverLocalStateDrift([TX_ERROR_INVALID_PROOF])).toBe(false);
    // A duplicate nullifier WITHIN one tx is malformed by the sender, unlike an already-committed one.
    expect(isReceiverLocalStateDrift([TX_ERROR_DUPLICATE_NULLIFIER_IN_TX])).toBe(false);
    // A single blameable reason keeps the whole rejection blameable.
    expect(isReceiverLocalStateDrift([TX_ERROR_INVALID_EXPIRATION_TIMESTAMP, TX_ERROR_INVALID_PROOF])).toBe(false);
  });

  it('is false for no reasons, so an unexplained rejection stays blameable', () => {
    expect(isReceiverLocalStateDrift([])).toBe(false);
  });
});
