import type { Fr } from '@aztec-labs/foundation/curves/bn254';
import type { Point } from '@aztec-labs/foundation/curves/grumpkin';
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import type { OnchainDeliveryMode } from '@aztec-labs/stdlib/logs';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- only referenced by a {@link} doc tag
import type { ResolveCustomRequest } from './resolve_custom_request.js';

/**
 * How a message's messaging secret is chosen: the wallet's strategy, returned by the `resolveMessagingSecretStrategy`
 * hook when no onchain handshake has been registered for the sender/recipient pair. This is intent (plus, for an
 * arbitrary secret, the raw material); PXE resolves it into the secret it hands the contract.
 */
export type MessagingSecretStrategy =
  | {
      /** Establish a fresh non-interactive handshake via the onchain registry; reveals the recipient onchain. */
      type: 'non-interactive-handshake';
    }
  | {
      /**
       * Establish a fresh interactive handshake via the onchain registry. Reveals nothing about the recipient
       * onchain, but requires the recipient to answer the registry's signed-authorization request (served through
       * the {@link ResolveCustomRequest} hook), so the send fails when it cannot be served.
       */
      type: 'interactive-handshake';
    }
  | {
      /** Derive the secret from the sender's and recipient's address keys via ECDH. PXE computes and silos it. */
      type: 'address-derived';
    }
  | {
      /**
       * Derive the secret from the recipient's tagging secret key, regardless of the sender. PXE computes and silos
       * it. Only usable when {@link MessagingSecretStrategyRequest.recipientTskAvailable} is set, typically for a local
       * account such as the sender itself - the send fails otherwise. Sound for both delivery modes, as constrained
       * delivery proves that the secret comes from that key. Contracts built against an Aztec.nr version that cannot
       * prove it get a non-interactive handshake for constrained delivery instead.
       *
       * Unlike an address-derived tag, this tag cannot be computed by an attacker able to break the recipient's address
       * key, for example with a quantum computer. The tagging key `tsk` is independent of the address key, and its
       * public counterpart `tpk` is never shared with untrusted contracts, only its hash.
       */
      type: 'recipient-tsk';
    }
  | {
      /**
       * A raw shared secret point the two parties already share offchain (e.g. coordinated out-of-band), supplied by
       * the wallet. PXE app-silos it before use. Only sound for unconstrained delivery, since nothing onchain proves
       * the recipient knows it.
       */
      type: 'arbitrary-secret';
      /** The raw (un-siloed) shared secret point to derive the tag from. */
      secret: Point;
    };

/** @deprecated Use {@link MessagingSecretStrategy}. */
export type TaggingSecretStrategy = MessagingSecretStrategy;

/**
 * The strategy PXE applies when no {@link ResolveMessagingSecretStrategy} hook is configured, for a hook to fall back
 * to.
 */
export function defaultMessagingSecretStrategy({
  recipientTskAvailable,
}: Pick<MessagingSecretStrategyRequest, 'recipientTskAvailable'>): MessagingSecretStrategy {
  return recipientTskAvailable ? { type: 'recipient-tsk' } : { type: 'non-interactive-handshake' };
}

/** @deprecated Use {@link defaultMessagingSecretStrategy}. */
export const defaultTaggingSecretStrategy = defaultMessagingSecretStrategy;

/** Information about the message delivery requesting a messaging secret strategy. */
export type MessagingSecretStrategyRequest = {
  contractAddress: AztecAddress;
  /**
   * The contract class ID of the executing contract, so wallets can apply class-level (not just per-address) policy.
   */
  contractClassId: Fr;
  sender: AztecAddress;
  recipient: AztecAddress;
  deliveryMode: OnchainDeliveryMode;
  /**
   * Whether PXE holds the recipient's keys and the recipient is in the execution's scopes, which dictates whether the
   * `recipient-tsk` strategy can be used.
   */
  recipientTskAvailable: boolean;
};

/** @deprecated Use {@link MessagingSecretStrategyRequest}. */
export type TaggingSecretStrategyRequest = MessagingSecretStrategyRequest;

/**
 * Hook returning the {@link MessagingSecretStrategy} for an outgoing message.
 *
 * PXE applies the returned strategy to every message without a registered handshake, including self-sends. A hook
 * with no policy for some messages can return {@link defaultMessagingSecretStrategy} for them.
 */
export type ResolveMessagingSecretStrategy = (
  request: MessagingSecretStrategyRequest,
) => Promise<MessagingSecretStrategy>;

/** @deprecated Use {@link ResolveMessagingSecretStrategy}. */
export type ResolveTaggingSecretStrategy = ResolveMessagingSecretStrategy;
