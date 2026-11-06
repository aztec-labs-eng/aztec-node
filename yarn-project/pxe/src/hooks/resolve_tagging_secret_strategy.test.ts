import { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

import { defaultTaggingSecretStrategy } from './resolve_tagging_secret_strategy.js';

describe('defaultTaggingSecretStrategy', () => {
  it('uses the recipient tsk for unconstrained delivery when it is available', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: OnchainDeliveryMode.UNCONSTRAINED, recipientTskAvailable: true }),
    ).toEqual({ type: 'recipient-tsk' });
  });

  it('uses a non-interactive handshake for unconstrained delivery when the recipient tsk is not available', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: OnchainDeliveryMode.UNCONSTRAINED, recipientTskAvailable: false }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for constrained delivery even when the recipient tsk is available', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: OnchainDeliveryMode.CONSTRAINED, recipientTskAvailable: true }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for constrained delivery when the recipient tsk is not available', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: OnchainDeliveryMode.CONSTRAINED, recipientTskAvailable: false }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });
});
