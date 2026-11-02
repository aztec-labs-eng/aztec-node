import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { Point } from '@aztec-labs/foundation/curves/grumpkin';
import { type TaggingSecretStrategy, defaultTaggingSecretStrategy } from '@aztec-labs/pxe/server';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

import { makeResolveTaggingSecretStrategyHook } from './tagging_secret_strategy.js';

const SENDER = AztecAddress.fromNumberUnsafe(1);
const OTHER_ACCOUNT = AztecAddress.fromNumberUnsafe(2);

describe('makeResolveTaggingSecretStrategyHook', () => {
  it('returns undefined when no TXE strategy is configured', () => {
    expect(makeResolveTaggingSecretStrategyHook(new Map())).toBeUndefined();
  });

  it('selects a strategy by delivery mode', async () => {
    const unconstrained: TaggingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const constrained: TaggingSecretStrategy = { type: 'interactive-handshake' };
    const hook = makeResolveTaggingSecretStrategyHook(
      new Map<OnchainDeliveryMode, TaggingSecretStrategy>([
        [OnchainDeliveryMode.UNCONSTRAINED, unconstrained],
        [OnchainDeliveryMode.CONSTRAINED, constrained],
      ]),
    );

    await expect(hook?.(makeRequest(OnchainDeliveryMode.UNCONSTRAINED, OTHER_ACCOUNT))).resolves.toBe(unconstrained);
    await expect(hook?.(makeRequest(OnchainDeliveryMode.CONSTRAINED, OTHER_ACCOUNT))).resolves.toBe(constrained);
  });

  it('applies a configured strategy to a self-send', async () => {
    const unconstrained: TaggingSecretStrategy = { type: 'arbitrary-secret', secret: await Point.random() };
    const hook = makeResolveTaggingSecretStrategyHook(new Map([[OnchainDeliveryMode.UNCONSTRAINED, unconstrained]]));

    await expect(hook?.(makeRequest(OnchainDeliveryMode.UNCONSTRAINED, SENDER))).resolves.toBe(unconstrained);
  });

  it.each([
    ['a self-send', SENDER],
    ['another account', OTHER_ACCOUNT],
  ])('defaults an unset mode to the PXE default strategy for %s', async (_, recipient) => {
    const hook = makeResolveTaggingSecretStrategyHook(
      new Map([[OnchainDeliveryMode.CONSTRAINED, { type: 'interactive-handshake' as const }]]),
    );
    const request = makeRequest(OnchainDeliveryMode.UNCONSTRAINED, recipient);

    await expect(hook?.(request)).resolves.toEqual(defaultTaggingSecretStrategy(request));
  });
});

function makeRequest(deliveryMode: OnchainDeliveryMode, recipient: AztecAddress) {
  return {
    contractAddress: AztecAddress.ZERO,
    contractClassId: Fr.ZERO,
    sender: SENDER,
    recipient,
    deliveryMode,
  };
}
