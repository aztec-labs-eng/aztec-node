import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { AppTaggingSecretKind } from '@aztec-labs/stdlib/logs';

import { defaultTaggingSecretStrategy } from './resolve_tagging_secret_strategy.js';

describe('defaultTaggingSecretStrategy', () => {
  let sender: AztecAddress;
  let recipient: AztecAddress;

  beforeAll(async () => {
    sender = await AztecAddress.random();
    recipient = await AztecAddress.random();
  });

  it('uses an address-derived secret for an unconstrained self-send', () => {
    expect(
      defaultTaggingSecretStrategy({ sender, recipient: sender, deliveryMode: AppTaggingSecretKind.UNCONSTRAINED }),
    ).toEqual({ type: 'address-derived' });
  });

  it('uses a non-interactive handshake for unconstrained delivery to another account', () => {
    expect(
      defaultTaggingSecretStrategy({ sender, recipient, deliveryMode: AppTaggingSecretKind.UNCONSTRAINED }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });

  it('uses a non-interactive handshake for a constrained self-send', () => {
    expect(
      defaultTaggingSecretStrategy({ sender, recipient: sender, deliveryMode: AppTaggingSecretKind.CONSTRAINED }),
    ).toEqual({ type: 'non-interactive-handshake' });
  });
});
