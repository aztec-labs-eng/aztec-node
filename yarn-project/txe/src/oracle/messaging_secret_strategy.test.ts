import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { type MessagingSecretStrategy, defaultMessagingSecretStrategy } from '@aztec-labs/pxe/server';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

import { makeResolveMessagingSecretStrategyHook } from './messaging_secret_strategy.js';

const SENDER = AztecAddress.fromNumberUnsafe(1);
const OTHER_ACCOUNT = AztecAddress.fromNumberUnsafe(2);

describe('makeResolveMessagingSecretStrategyHook', () => {
  it('returns undefined when no TXE strategy is configured', () => {
    expect(makeResolveMessagingSecretStrategyHook(new Map())).toBeUndefined();
  });

  it('selects a strategy by delivery mode', async () => {
    const unconstrained: MessagingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const constrained: MessagingSecretStrategy = { type: 'interactive-handshake' };
    const hook = makeResolveMessagingSecretStrategyHook(
      new Map<OnchainDeliveryMode, MessagingSecretStrategy>([
        [OnchainDeliveryMode.UNCONSTRAINED, unconstrained],
        [OnchainDeliveryMode.CONSTRAINED, constrained],
      ]),
    );

    await expect(hook?.(makeRequest(OnchainDeliveryMode.UNCONSTRAINED, OTHER_ACCOUNT, false))).resolves.toBe(
      unconstrained,
    );
    await expect(hook?.(makeRequest(OnchainDeliveryMode.CONSTRAINED, OTHER_ACCOUNT, false))).resolves.toBe(constrained);
  });

  it('applies a configured strategy to a self-send', async () => {
    const unconstrained: MessagingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const hook = makeResolveMessagingSecretStrategyHook(new Map([[OnchainDeliveryMode.UNCONSTRAINED, unconstrained]]));

    await expect(hook?.(makeRequest(OnchainDeliveryMode.UNCONSTRAINED, SENDER, false))).resolves.toBe(unconstrained);
  });

  it.each([
    ['is available', true],
    ['is not available', false],
  ])(
    'defaults an unset mode to the PXE default strategy when the recipient tsk %s',
    async (_, recipientTskAvailable) => {
      const hook = makeResolveMessagingSecretStrategyHook(
        new Map([[OnchainDeliveryMode.CONSTRAINED, { type: 'interactive-handshake' as const }]]),
      );
      const request = makeRequest(OnchainDeliveryMode.UNCONSTRAINED, OTHER_ACCOUNT, recipientTskAvailable);

      await expect(hook?.(request)).resolves.toEqual(defaultMessagingSecretStrategy(request));
    },
  );
});

function makeRequest(deliveryMode: OnchainDeliveryMode, recipient: AztecAddress, recipientTskAvailable: boolean) {
  return {
    contractAddress: AztecAddress.ZERO,
    contractClassId: Fr.ZERO,
    sender: SENDER,
    recipient,
    deliveryMode,
    recipientTskAvailable,
  };
}
