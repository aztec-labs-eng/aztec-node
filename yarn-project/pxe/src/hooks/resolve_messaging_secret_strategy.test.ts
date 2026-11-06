import { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

import { defaultMessagingSecretStrategy } from './resolve_messaging_secret_strategy.js';

describe('defaultMessagingSecretStrategy', () => {
  it('uses the recipient tsk for unconstrained delivery when it is available', () => {
    expect(
      defaultMessagingSecretStrategy({ deliveryMode: OnchainDeliveryMode.UNCONSTRAINED, recipientTskAvailable: true }),
    ).toEqual({ type: 'recipient-tsk' });
  });

  it('uses a non-interactive handshake for unconstrained delivery when the recipient tsk is not available', () => {
    expect(
      defaultMessagingSecretStrategy({ deliveryMode: OnchainDeliveryMode.UNCONSTRAINED, recipientTskAvailable: false }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for constrained delivery even when the recipient tsk is available', () => {
    expect(
      defaultMessagingSecretStrategy({ deliveryMode: OnchainDeliveryMode.CONSTRAINED, recipientTskAvailable: true }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for constrained delivery when the recipient tsk is not available', () => {
    expect(
      defaultMessagingSecretStrategy({ deliveryMode: OnchainDeliveryMode.CONSTRAINED, recipientTskAvailable: false }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });
});
