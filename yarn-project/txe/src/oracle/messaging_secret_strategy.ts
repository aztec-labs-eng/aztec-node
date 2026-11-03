import {
  type MessagingSecretStrategy,
  type ResolveMessagingSecretStrategy,
  defaultMessagingSecretStrategy,
} from '@aztec-labs/pxe/server';
import type { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

/**
 * The messaging secret strategies a TXE test has configured, keyed by delivery mode. Absence means "not configured".
 */
export type TXEMessagingSecretStrategies = Map<OnchainDeliveryMode, MessagingSecretStrategy>;

/**
 * Builds the `resolveMessagingSecretStrategy` hook backing the `aztec_txe_setMessagingSecretStrategies` oracle. Returns
 * `undefined` when no strategy is configured, so PXE's own no-hook default path is exercised. When at least one mode
 * is configured, modes without an entry resolve to {@link defaultMessagingSecretStrategy}, matching what PXE would
 * apply without a hook.
 */
export function makeResolveMessagingSecretStrategyHook(
  strategies: TXEMessagingSecretStrategies,
): ResolveMessagingSecretStrategy | undefined {
  if (strategies.size === 0) {
    return undefined;
  }

  return request => Promise.resolve(strategies.get(request.deliveryMode) ?? defaultMessagingSecretStrategy(request));
}
