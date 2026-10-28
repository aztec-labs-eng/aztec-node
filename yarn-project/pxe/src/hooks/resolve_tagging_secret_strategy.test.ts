import { AppTaggingSecretKind } from '@aztec-labs/stdlib/logs';

import { defaultTaggingSecretStrategy } from './resolve_tagging_secret_strategy.js';

describe('defaultTaggingSecretStrategy', () => {
  it('uses an address-derived secret for an unconstrained self-send', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: AppTaggingSecretKind.UNCONSTRAINED, recipientIsOwnAccount: true }),
    ).toEqual({ type: 'address-derived' });
  });

  it('uses a non-interactive handshake for unconstrained delivery to an external recipient', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: AppTaggingSecretKind.UNCONSTRAINED, recipientIsOwnAccount: false }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for a constrained self-send', () => {
    expect(
      defaultTaggingSecretStrategy({ deliveryMode: AppTaggingSecretKind.CONSTRAINED, recipientIsOwnAccount: true }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });
});
