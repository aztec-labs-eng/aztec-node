import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { KeyStore } from '@aztec-labs/key-store';
import { type TaggingSecretStrategy, defaultTaggingSecretStrategy } from '@aztec-labs/pxe/server';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { AppTaggingSecretKind } from '@aztec-labs/stdlib/logs';
import { mock } from 'jest-mock-extended';

import { makeResolveTaggingSecretStrategyHook } from './tagging_secret_strategy.js';

describe('makeResolveTaggingSecretStrategyHook', () => {
  it('returns undefined when no TXE strategy is configured', () => {
    expect(makeResolveTaggingSecretStrategyHook(new Map(), makeKeyStore({ ownsRecipient: false }))).toBeUndefined();
  });

  it('selects a strategy by delivery mode', async () => {
    const unconstrained: TaggingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const constrained: TaggingSecretStrategy = { type: 'interactive-handshake' };
    const hook = makeResolveTaggingSecretStrategyHook(
      new Map<AppTaggingSecretKind, TaggingSecretStrategy>([
        [AppTaggingSecretKind.UNCONSTRAINED, unconstrained],
        [AppTaggingSecretKind.CONSTRAINED, constrained],
      ]),
      makeKeyStore({ ownsRecipient: false }),
    );

    await expect(hook?.(makeRequest(AppTaggingSecretKind.UNCONSTRAINED))).resolves.toBe(unconstrained);
    await expect(hook?.(makeRequest(AppTaggingSecretKind.CONSTRAINED))).resolves.toBe(constrained);
  });

  it('applies a configured strategy to a self-send', async () => {
    const unconstrained: TaggingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const hook = makeResolveTaggingSecretStrategyHook(
      new Map([[AppTaggingSecretKind.UNCONSTRAINED, unconstrained]]),
      makeKeyStore({ ownsRecipient: true }),
    );

    await expect(hook?.(makeRequest(AppTaggingSecretKind.UNCONSTRAINED))).resolves.toBe(unconstrained);
  });

  it.each([true, false])(
    'defaults an unset mode to the PXE default strategy (recipient is own account: %s)',
    async ownsRecipient => {
      const hook = makeResolveTaggingSecretStrategyHook(
        new Map([[AppTaggingSecretKind.CONSTRAINED, { type: 'interactive-handshake' as const }]]),
        makeKeyStore({ ownsRecipient }),
      );

      await expect(hook?.(makeRequest(AppTaggingSecretKind.UNCONSTRAINED))).resolves.toEqual(
        defaultTaggingSecretStrategy({
          deliveryMode: AppTaggingSecretKind.UNCONSTRAINED,
          recipientIsOwnAccount: ownsRecipient,
        }),
      );
    },
  );
});

function makeRequest(deliveryMode: AppTaggingSecretKind) {
  return {
    contractAddress: AztecAddress.ZERO,
    contractClassId: Fr.ZERO,
    sender: AztecAddress.ZERO,
    recipient: AztecAddress.ZERO,
    deliveryMode,
  };
}

function makeKeyStore({ ownsRecipient }: { ownsRecipient: boolean }) {
  const keyStore = mock<KeyStore>();
  keyStore.hasAccount.mockResolvedValue(ownsRecipient);
  return keyStore;
}
