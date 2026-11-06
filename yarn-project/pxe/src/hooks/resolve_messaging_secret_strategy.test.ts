import { defaultMessagingSecretStrategy } from './resolve_messaging_secret_strategy.js';

describe('defaultMessagingSecretStrategy', () => {
  it('uses the recipient tsk when it is available', () => {
    expect(defaultMessagingSecretStrategy({ recipientTskAvailable: true })).toEqual({ type: 'recipient-tsk' });
  });

  it('uses a non-interactive handshake when the recipient tsk is not available', () => {
    expect(defaultMessagingSecretStrategy({ recipientTskAvailable: false })).toEqual({
      type: 'non-interactive-handshake',
    });
  });
});
